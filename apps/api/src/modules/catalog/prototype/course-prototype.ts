import type { CourseLevel, Currency } from '@masternova/db';
import type { NewCourse, NewSection } from '../repositories/course.writer.interface';

/**
 * The Prototype: deep-copy a course's *metadata* graph, cheaply, then let the caller mutate it.
 *
 * **The force, and it is a real one.** A course with 40 lectures is roughly 12 GB of
 * transcoded HLS. A duplicate that copied bytes would take minutes, cost storage twice, and
 * re-run the whole task 1.7 pipeline for content that is byte-identical. So the copy is deep
 * over everything mutable — course fields, sections, lectures, positions, preview flags —
 * and deliberately **shallow over `assetId`**, because an asset is immutable content and
 * sharing a reference to it is correct.
 *
 * That shallow edge has a consequence task 1.6 must honour: assets are refcounted or
 * soft-deleted, never deleted when one course that references them is archived. It is
 * written down here, and asserted by a test, so nobody "fixes" it later.
 *
 * This function is pure — no I/O, no injection, no database. `CourseDuplicationService`
 * fetches, calls this, and writes. That separation is what lets the interesting behaviour
 * be tested without Postgres.
 */

export interface CourseAggregate {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly description: string;
  readonly language: string;
  readonly level: CourseLevel;
  readonly instructorId: string;
  readonly categoryId: string | null;
  readonly topics: string[];
  readonly priceMinor: number;
  readonly listPriceMinor: number | null;
  readonly currency: Currency;
  readonly thumbnailKey: string | null;
  readonly promoVideoAssetId: string | null;
  readonly lectureCount: number;
  readonly totalDurationSeconds: number;
  readonly sections: readonly {
    readonly title: string;
    readonly position: number;
    readonly lectures: readonly {
      readonly title: string;
      readonly description: string | null;
      readonly kind: 'VIDEO' | 'ARTICLE';
      readonly position: number;
      readonly isPreview: boolean;
      readonly durationSeconds: number;
      readonly assetId: string | null;
      readonly articleBody: string | null;
    }[];
  }[];
}

export interface CloneOverrides {
  /** Who owns the copy. An admin duplicating on someone's behalf keeps the original owner. */
  readonly instructorId: string;
  /** Supplied by the caller so the pure function stays deterministic and testable. */
  readonly slug: string;
  readonly title?: string;
}

export interface CourseDraft {
  readonly course: NewCourse;
  readonly sections: NewSection[];
}

const COPY_SUFFIX = ' (copy)';

export function cloneCourse(source: CourseAggregate, overrides: CloneOverrides): CourseDraft {
  return {
    course: {
      slug: overrides.slug,
      title: overrides.title ?? withCopySuffix(source.title),
      subtitle: source.subtitle ?? undefined,
      description: source.description,
      language: source.language,
      level: source.level,
      instructorId: overrides.instructorId,
      categoryId: source.categoryId,
      topics: [...source.topics],
      // Pricing carries over: a duplicate is a starting point, and re-entering the price
      // is the first thing anyone would do anyway.
      priceMinor: source.priceMinor,
      listPriceMinor: source.listPriceMinor,
      currency: source.currency,
      thumbnailKey: source.thumbnailKey,
      // Shared, not copied — see the note at the top of this file.
      promoVideoAssetId: source.promoVideoAssetId,
      lectureCount: source.lectureCount,
      totalDurationSeconds: source.totalDurationSeconds,
    },
    sections: source.sections.map((section) => ({
      title: section.title,
      position: section.position,
      lectures: section.lectures.map((lecture) => ({
        title: lecture.title,
        description: lecture.description,
        kind: lecture.kind,
        position: lecture.position,
        isPreview: lecture.isPreview,
        durationSeconds: lecture.durationSeconds,
        assetId: lecture.assetId,
        articleBody: lecture.articleBody,
      })),
    })),
  };
}

/**
 * Everything the copy must NOT inherit is absent from the draft above, not stripped
 * afterwards: `status` defaults to DRAFT, `publishedAt` and `version` to their column
 * defaults, and the rating and enrollment counters to zero. Those describe the *original's*
 * history, not its content, and a copy that inherited "4.8 from 2,100 learners" would be a
 * lie the moment it was published.
 */

/** Cloning a clone stays `X (copy)` rather than accumulating suffixes. */
function withCopySuffix(title: string): string {
  return title.endsWith(COPY_SUFFIX) ? title : `${title}${COPY_SUFFIX}`;
}
