import type { Course } from '@masternova/db';
import type { InstructorCourse } from '@masternova/shared';

/**
 * Prisma row → the authoring wire shape.
 *
 * Three conversions, each of which caused a real bug before this existed: `Decimal` becomes
 * a number (it serializes as `0` over HTTP but as `{d,e,s}` through a JSON column, so an
 * idempotent replay returned a different body than the original call), `Date` becomes an
 * ISO string, and the internal `ratingSum` never leaves the server at all.
 */
export function toInstructorCourse(course: Course): InstructorCourse {
  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    subtitle: course.subtitle,
    description: course.description,
    language: course.language,
    level: course.level,
    status: course.status,
    categoryId: course.categoryId,
    topics: course.topics,
    thumbnailKey: course.thumbnailKey,
    promoVideoAssetId: course.promoVideoAssetId,
    priceMinor: course.priceMinor,
    listPriceMinor: course.listPriceMinor,
    currency: course.currency,
    ratingAverage: Number(course.ratingAverage),
    ratingCount: course.ratingCount,
    enrollmentCount: course.enrollmentCount,
    lectureCount: course.lectureCount,
    totalDurationSeconds: course.totalDurationSeconds,
    version: course.version,
    publishedAt: course.publishedAt?.toISOString() ?? null,
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
  };
}
