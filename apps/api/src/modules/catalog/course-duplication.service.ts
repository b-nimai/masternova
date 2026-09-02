import { Inject, Injectable } from '@nestjs/common';
import type { Course } from '@masternova/db';
import { UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import { slugify } from '../../common/utils/slug';
import { CourseNotFoundException } from '../../common/exceptions';
import { COURSE_READER, type ICourseReader } from './repositories/course.reader.interface';
import { COURSE_WRITER, type ICourseWriter } from './repositories/course.writer.interface';
import { cloneCourse } from './prototype/course-prototype';
import { CourseAccessService } from './course-access.service';
import type { Actor } from './actor';

/**
 * "Duplicate this course" — the Prototype, wired up.
 *
 * It does three things and nothing else: read the aggregate, hand it to the pure
 * `cloneCourse`, and write the result in one transaction. All the interesting behaviour
 * (what is reset, what is shared, how the title is suffixed) lives in the pure function,
 * which is why it can be tested without a database at all.
 *
 * It is the one operation in this module that genuinely needs both repository roles, and
 * its constructor says so rather than hiding it behind a combined interface.
 *
 * Deliberately **not** behind an `ICourseDuplicator` interface: there is one implementation
 * and there will only ever be one, and CLAUDE.md §3 is explicit that one implementation is
 * not a seam.
 */
@Injectable()
export class CourseDuplicationService {
  constructor(
    @Inject(COURSE_READER) private readonly reader: ICourseReader,
    @Inject(COURSE_WRITER) private readonly writer: ICourseWriter,
    private readonly access: CourseAccessService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async duplicate(sourceId: string, actor: Actor): Promise<Course> {
    // Ownership through the shared check, then the deep read. An archived course is still
    // duplicable on purpose: a copy is a fresh DRAFT, and that is the only supported way to
    // bring an archived course's content back — see `COURSE_LIFECYCLE`.
    await this.access.assertOwned(sourceId, actor);
    const source = await this.reader.findDeepById(sourceId);
    if (!source) throw new CourseNotFoundException();

    // An admin duplicating on someone's behalf leaves the copy with the original owner;
    // anything else would silently move a course between instructors' dashboards.
    const owner = actor.role === 'ADMIN' ? source.instructorId : actor.id;
    const draft = cloneCourse(source, { instructorId: owner, slug: slugify(source.title) });

    return this.uow.execute(async (ctx) => {
      const copy = await this.writer.create(draft.course, ctx.executor);
      // The same executor, so a half-copied course — metadata written, sections missing —
      // is not a state the database can be left in.
      await this.writer.insertSections(copy.id, draft.sections, ctx.executor);

      ctx.publish({
        type: 'catalog.course.duplicated',
        aggregateType: 'Course',
        aggregateId: copy.id,
        payload: { courseId: copy.id, sourceCourseId: sourceId, instructorId: owner },
      });

      return copy;
    });
  }
}
