import type { CourseLevel, CourseStatus, Role } from '@masternova/db';
import { InvalidPriceRangeException } from '../../../common/exceptions';
import { defineSpecification, or, type CourseSpecification } from './course-specification';

/**
 * The leaves. Each one is a single named rule; everything interesting is built by
 * composing them, which is what keeps `PrismaCourseRepository.list` written once and
 * never edited again (CLAUDE.md §1 O).
 */

export const isPublished = (): CourseSpecification =>
  defineSpecification(
    'published',
    () => ({ status: 'PUBLISHED' }),
    (course) => course.status === 'PUBLISHED',
  );

export const hasStatus = (status: CourseStatus): CourseSpecification =>
  defineSpecification(
    `status=${status}`,
    () => ({ status }),
    (course) => course.status === status,
  );

export const byInstructor = (instructorId: string): CourseSpecification =>
  defineSpecification(
    `instructor=${instructorId}`,
    () => ({ instructorId }),
    (course) => course.instructorId === instructorId,
  );

export const inCategory = (categoryId: string): CourseSpecification =>
  defineSpecification(
    `category=${categoryId}`,
    () => ({ categoryId }),
    (course) => course.categoryId === categoryId,
  );

/** A top-level category browse: the parent plus every subcategory beneath it. */
export const inCategoryTree = (categoryIds: readonly string[]): CourseSpecification =>
  defineSpecification(
    `category in [${categoryIds.join(',')}]`,
    () => ({ categoryId: { in: [...categoryIds] } }),
    (course) => course.categoryId !== null && categoryIds.includes(course.categoryId),
  );

export const atLevel = (level: CourseLevel): CourseSpecification =>
  defineSpecification(
    `level=${level}`,
    () => ({ level }),
    (course) => course.level === level,
  );

export const inLanguage = (language: string): CourseSpecification =>
  defineSpecification(
    `language=${language}`,
    () => ({ language }),
    (course) => course.language === language,
  );

export const isFree = (): CourseSpecification =>
  defineSpecification(
    'free',
    () => ({ priceMinor: 0 }),
    (course) => course.priceMinor === 0,
  );

/**
 * Both bounds inclusive, in minor units.
 *
 * An inverted range throws rather than quietly matching nothing: a UI that sent
 * `min=9900&max=0` has a bug, and answering "no results" hides it.
 */
export const priceBetween = (minMinor: number, maxMinor: number): CourseSpecification => {
  if (minMinor > maxMinor) throw new InvalidPriceRangeException();

  return defineSpecification(
    `price in [${minMinor},${maxMinor}]`,
    () => ({ priceMinor: { gte: minMinor, lte: maxMinor } }),
    (course) => course.priceMinor >= minMinor && course.priceMinor <= maxMinor,
  );
};

export const ratedAtLeast = (stars: number): CourseSpecification =>
  defineSpecification(
    `rating>=${stars}`,
    () => ({ ratingAverage: { gte: stars } }),
    (course) => course.ratingAverage >= stars,
  );

/**
 * Interim search, and labelled as such.
 *
 * A case-insensitive substring match served by a `pg_trgm` GIN index. Typesense replaces
 * it in task 1.13 — and replaces this leaf, not the architecture, which is the point of
 * the pattern.
 */
export const titleMatches = (query: string): CourseSpecification =>
  defineSpecification(
    `title~${query}`,
    () => ({ title: { contains: query, mode: 'insensitive' } }),
    (course) => course.title.toLowerCase().includes(query.toLowerCase()),
  );

export const hasTopic = (topic: string): CourseSpecification =>
  defineSpecification(
    `topic=${topic}`,
    () => ({ topics: { has: topic } }),
    (course) => course.topics.includes(topic),
  );

export interface Viewer {
  readonly id: string;
  readonly role: Role;
}

/**
 * ⭐ The rule the whole pattern is here for.
 *
 * One object decides what any viewer may see, and the list, the detail page and the
 * instructor dashboard all ask it. A visibility rule duplicated across three query sites
 * is a visibility rule that will one day be updated in two of them — and the one that gets
 * missed leaks an unpublished course.
 *
 * It is also composed into the `where`, never applied afterwards: a draft therefore **404s**
 * for a stranger rather than returning 200-then-403, which would confirm that the course
 * exists.
 */
export const visibleTo = (viewer?: Viewer): CourseSpecification => {
  if (!viewer) return isPublished();
  if (viewer.role === 'ADMIN') {
    return defineSpecification(
      'admin: all',
      () => ({}),
      () => true,
    );
  }
  return or(isPublished(), byInstructor(viewer.id));
};
