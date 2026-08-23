import type { CourseLevel, Course, CourseStatus, Currency } from '@masternova/db';

/** Injection token for the **write** role. See the note on `COURSE_READER` for the split. */
export const COURSE_WRITER = Symbol('COURSE_WRITER');

export interface NewCourse {
  readonly slug: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly description: string;
  readonly language: string;
  readonly level: CourseLevel;
  readonly instructorId: string;
  readonly categoryId?: string | null;
  readonly topics: string[];
  readonly priceMinor?: number;
  readonly listPriceMinor?: number | null;
  readonly currency?: Currency;
  readonly thumbnailKey?: string | null;
  readonly promoVideoAssetId?: string | null;
  readonly lectureCount?: number;
  readonly totalDurationSeconds?: number;
}

export interface CourseDetailsPatch {
  readonly title?: string;
  readonly subtitle?: string;
  readonly description?: string;
  readonly language?: string;
  readonly level?: CourseLevel;
  readonly categoryId?: string | null;
  readonly topics?: string[];
  readonly thumbnailKey?: string | null;
  readonly promoVideoAssetId?: string | null;
}

export interface CoursePricing {
  readonly priceMinor: number;
  readonly listPriceMinor: number | null;
  readonly currency: Currency;
}

export interface NewLecture {
  readonly title: string;
  readonly description?: string | null;
  readonly kind: 'VIDEO' | 'ARTICLE';
  readonly position: number;
  readonly isPreview: boolean;
  readonly durationSeconds: number;
  /** Deliberately carried across a duplicate rather than regenerated — see the Prototype. */
  readonly assetId?: string | null;
  readonly articleBody?: string | null;
}

export interface NewSection {
  readonly title: string;
  readonly position: number;
  readonly lectures: NewLecture[];
}

/**
 * The **write** role.
 *
 * Note what is missing: there is no `delete`. Archiving is the delete. A hard delete would
 * orphan the orders and enrollments that point here from tasks 1.9 and 1.10, and "where did
 * the course I paid for go?" is not a support ticket worth having.
 *
 * `insertSections` is bulk-only, because the only callers in this task are the Prototype and
 * the seeder. Per-section editing is task 1.5's wizard, and giving it a method here now
 * would be an interface designed for a caller that does not exist.
 *
 * `executor` is the opaque `TransactionExecutor` from `@masternova/contracts`. Passing it
 * makes a write join the caller's Unit of Work; omitting it uses the default connection.
 */
export interface ICourseWriter {
  create(data: NewCourse, executor?: unknown): Promise<Course>;
  updateDetails(id: string, data: CourseDetailsPatch, executor?: unknown): Promise<Course>;
  updatePricing(id: string, data: CoursePricing, executor?: unknown): Promise<Course>;
  setStatus(id: string, status: CourseStatus, executor?: unknown): Promise<Course>;
  insertSections(courseId: string, sections: NewSection[], executor?: unknown): Promise<void>;
}
