import type { Course, Lecture } from '@masternova/db';

export const ACCESS_SUBJECT_READER = Symbol('ACCESS_SUBJECT_READER');

/** Exactly the course fields the policies read, and not one more (CLAUDE.md §1 I). */
export type CourseSubject = Pick<
  Course,
  'id' | 'instructorId' | 'status' | 'priceMinor' | 'priceSetAt'
>;

export type LectureSubject = Pick<Lecture, 'id' | 'isPreview' | 'assetId'>;

export interface LectureWithCourse {
  readonly lecture: LectureSubject;
  readonly course: CourseSubject;
}

/**
 * What a decision is *about*: the course, and optionally the lecture inside it.
 *
 * **Why entitlement has its own reader instead of calling catalog's.** A module may only
 * see another through its public contract (CLAUDE.md §4), and `ICourseReader` is catalog's
 * internal interface shaped for catalog's job — visibility specifications, deep aggregates,
 * cursor pages. None of that is wanted here, and depending on it would make every change to
 * catalog's read model a change to the authorization path.
 *
 * It also buys the thing that matters on the hot path: `lectureWithCourse` is **one query**
 * that walks lecture → section → course, where asking catalog would have been two round
 * trips and a join done in JavaScript.
 */
export interface IAccessSubjectReader {
  findCourse(courseId: string): Promise<CourseSubject | null>;
  lectureWithCourse(lectureId: string): Promise<LectureWithCourse | null>;
}
