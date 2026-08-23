import { Inject, Injectable } from '@nestjs/common';
import type { Course } from '@masternova/db';
import { UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import { slugify } from '../../common/utils/slug';
import { CourseNotFoundException, NotCourseOwnerException } from '../../common/exceptions';
import { COURSE_READER, type ICourseReader } from './repositories/course.reader.interface';
import { COURSE_WRITER, type ICourseWriter } from './repositories/course.writer.interface';
import { cloneCourse } from './prototype/course-prototype';
import type { Actor } from './course-editing.service';

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
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async duplicate(sourceId: string, actor: Actor): Promise<Course> {
    const source = await this.reader.findDeepById(sourceId);
    if (!source) throw new CourseNotFoundException();
    if (actor.role !== 'ADMIN' && source.instructorId !== actor.id) {
      throw new NotCourseOwnerException();
    }

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
