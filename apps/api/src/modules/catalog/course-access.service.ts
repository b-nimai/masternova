import { Inject, Injectable } from '@nestjs/common';
import type { Course } from '@masternova/db';
import {
  CourseIsArchivedException,
  CourseNotFoundException,
  NotCourseOwnerException,
} from '../../common/exceptions';
import { COURSE_READER, type ICourseReader } from './repositories/course.reader.interface';
import type { Actor } from './actor';

/**
 * One question: may this actor author this course, and is the course still writable?
 *
 * It exists because four services were about to ask it — editing, lifecycle, curriculum and
 * duplication — and an authorization rule copied four times is an authorization rule that
 * will be four different rules within a month. Extracting it also names the seam: when
 * co-instructors arrive, this is the only file that changes.
 *
 * It reads through `findById`, which ignores visibility on purpose. This is an authorization
 * check and it must see the row as it is, including the statuses `visibleTo` would hide from
 * the very person who owns them.
 */
@Injectable()
export class CourseAccessService {
  constructor(@Inject(COURSE_READER) private readonly courses: ICourseReader) {}

  async assertOwned(courseId: string, actor: Actor): Promise<Course> {
    const course = await this.courses.findById(courseId);
    if (!course) throw new CourseNotFoundException();
    if (actor.role !== 'ADMIN' && course.instructorId !== actor.id) {
      throw new NotCourseOwnerException();
    }
    return course;
  }

  /**
   * Ownership plus "and it is not archived".
   *
   * Archiving is the delete this domain has (there is no `delete` on `ICourseWriter`), so an
   * archived course must be as immutable as a deleted one — otherwise a course taken down
   * over a rights complaint can be quietly edited and duplicated back into the catalog.
   * Lifecycle transitions deliberately do NOT go through here: the state machine already
   * knows ARCHIVED is terminal, and it gives a better error.
   */
  async assertEditable(courseId: string, actor: Actor): Promise<Course> {
    const course = await this.assertOwned(courseId, actor);
    if (course.status === 'ARCHIVED') throw new CourseIsArchivedException();
    return course;
  }
}
