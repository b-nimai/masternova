import type { Course } from '@masternova/db';
import type { CourseDetail, CourseListItem, CourseSort } from '@masternova/shared';
import type { CourseSpecification } from '../specifications/course-specification';
import type { CourseAggregate } from '../prototype/course-prototype';

/**
 * Injection token for the **read** role of the course repository.
 *
 * It is a separate token from `COURSE_WRITER` even though one class implements both
 * (CLAUDE.md §1 I). Interface Segregation is about what the *client* depends on: the
 * public `CoursesController` injects this and cannot reach a write method even by
 * accident, and the search indexer in task 1.13 will depend on it alone. It is also the
 * half that gets a caching Decorator, and a cache wrapper around a write interface would
 * be nonsense.
 */
export const COURSE_READER = Symbol('COURSE_READER');

export interface CursorPage {
  readonly sort: CourseSort;
  readonly limit: number;
  /** Already decoded and validated by the service; the repository never parses strings. */
  readonly after?: CourseSpecification;
}

export interface CursorSlice<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface ICourseReader {
  findBySlug(slug: string, spec: CourseSpecification): Promise<CourseDetail | null>;
  /**
   * The raw row, ignoring every visibility rule.
   *
   * It exists for the write path's ownership and transition checks, which must see the
   * course as it actually is — including statuses `visibleTo` would hide from the person
   * who owns it. Never reachable from a public endpoint.
   */
  findById(id: string): Promise<Course | null>;
  /** The full aggregate, for the Prototype. Not exposed over HTTP. */
  findDeepById(id: string): Promise<CourseAggregate | null>;
  list(spec: CourseSpecification, page: CursorPage): Promise<CursorSlice<CourseListItem>>;
  /**
   * Admin and diagnostics only — never the list path. Counting the matching set on every
   * page is exactly the cost keyset pagination exists to avoid.
   */
  countMatching(spec: CourseSpecification): Promise<number>;
}
