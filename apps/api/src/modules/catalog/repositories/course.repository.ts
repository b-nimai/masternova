import { Injectable } from '@nestjs/common';
import type { Course, CourseStatus, Prisma, PrismaClient } from '@masternova/db';
import type { CourseDetail, CourseListItem } from '@masternova/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import type { CourseSpecification } from '../specifications/course-specification';
import { and } from '../specifications/course-specification';
import { cursorKeyOf, encodeCursor, orderByFor } from '../cursor';
import type { CursorPage, CursorSlice, ICourseReader } from './course.reader.interface';
import type {
  CourseDetailsPatch,
  CoursePricing,
  ICourseWriter,
  NewCourse,
  NewSection,
} from './course.writer.interface';
import type { CourseAggregate } from '../prototype/course-prototype';

/** Everything a list card needs, and nothing it does not. */
const LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  level: true,
  language: true,
  status: true,
  thumbnailKey: true,
  ratingAverage: true,
  ratingCount: true,
  enrollmentCount: true,
  lectureCount: true,
  totalDurationSeconds: true,
  priceMinor: true,
  listPriceMinor: true,
  currency: true,
  publishedAt: true,
  updatedAt: true,
  instructor: { select: { id: true, name: true } },
  category: { select: { id: true, slug: true, name: true } },
} satisfies Prisma.CourseSelect;

/**
 * One class, two roles.
 *
 * It implements `ICourseReader` and `ICourseWriter` and is bound to both tokens with
 * `useExisting`, not two `useClass` registrations — two `useClass` entries would create two
 * instances of the same repository, which is wrong the moment anything is cached on one of
 * them. Interface Segregation is about what the *client* sees, not how many classes exist
 * (CLAUDE.md §1 I).
 *
 * It is also the only place in `catalog` that names Prisma. Services depend on the
 * interfaces, so a service test uses a fake instead of a database (§1 D).
 */
@Injectable()
export class PrismaCourseRepository implements ICourseReader, ICourseWriter {
  constructor(private readonly prisma: PrismaService) {}

  /** Unwraps the opaque Unit-of-Work handle. Nothing outside this file does this. */
  private client(executor?: unknown): PrismaClient {
    return (executor as PrismaClient) ?? this.prisma;
  }

  // ── read ────────────────────────────────────────────────────────────────

  /**
   * Fetches one page plus one row.
   *
   * The extra row is how "is there a next page?" is answered without a `COUNT`. It is
   * discarded before the response, and its absence is what makes `nextCursor` null.
   */
  async list(spec: CourseSpecification, page: CursorPage): Promise<CursorSlice<CourseListItem>> {
    const where = and(spec, ...(page.after ? [page.after] : [])).toWhere();

    const rows = await this.prisma.course.findMany({
      where,
      select: LIST_SELECT,
      orderBy: orderByFor(page.sort),
      take: page.limit + 1,
    });

    const hasMore = rows.length > page.limit;
    const items = (hasMore ? rows.slice(0, page.limit) : rows).map(toListItem);
    const last = hasMore ? rows[page.limit - 1] : undefined;

    return {
      items,
      nextCursor: last
        ? encodeCursor({
            sort: page.sort,
            key: cursorKeyOf(page.sort, {
              id: last.id,
              publishedAt: last.publishedAt,
              updatedAt: last.updatedAt,
              ratingAverage: last.ratingAverage,
              priceMinor: last.priceMinor,
            }),
            id: last.id,
          })
        : null,
    };
  }

  /**
   * Visibility is part of the `where`, not a check afterwards.
   *
   * That is what makes an invisible course a 404 rather than a 200-then-403 — a 403 would
   * confirm that the course exists, which is the leak this shape avoids.
   */
  async findBySlug(slug: string, spec: CourseSpecification): Promise<CourseDetail | null> {
    const row = await this.prisma.course.findFirst({
      where: { AND: [{ slug }, spec.toWhere()] },
      select: {
        ...LIST_SELECT,
        description: true,
        topics: true,
        promoVideoAssetId: true,
        version: true,
        sections: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            position: true,
            lectures: {
              orderBy: { position: 'asc' },
              select: {
                id: true,
                title: true,
                kind: true,
                position: true,
                isPreview: true,
                durationSeconds: true,
              },
            },
          },
        },
      },
    });

    if (!row) return null;

    return {
      ...toListItem(row),
      description: row.description,
      topics: row.topics,
      promoVideoAssetId: row.promoVideoAssetId,
      version: row.version,
      sections: row.sections,
    };
  }

  findById(id: string): Promise<Course | null> {
    return this.prisma.course.findUnique({ where: { id } });
  }

  async findDeepById(id: string): Promise<CourseAggregate | null> {
    const row = await this.prisma.course.findUnique({
      where: { id },
      include: {
        sections: {
          orderBy: { position: 'asc' },
          include: { lectures: { orderBy: { position: 'asc' } } },
        },
      },
    });
    if (!row) return null;

    return {
      ...row,
      sections: row.sections.map((section) => ({
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

  countMatching(spec: CourseSpecification): Promise<number> {
    return this.prisma.course.count({ where: spec.toWhere() });
  }

  // ── write ───────────────────────────────────────────────────────────────

  create(data: NewCourse, executor?: unknown): Promise<Course> {
    return this.client(executor).course.create({
      data: {
        slug: data.slug,
        title: data.title,
        subtitle: data.subtitle,
        description: data.description,
        language: data.language,
        level: data.level,
        instructorId: data.instructorId,
        categoryId: data.categoryId ?? null,
        topics: data.topics,
        priceMinor: data.priceMinor ?? 0,
        listPriceMinor: data.listPriceMinor ?? null,
        currency: data.currency ?? 'INR',
        thumbnailKey: data.thumbnailKey ?? null,
        promoVideoAssetId: data.promoVideoAssetId ?? null,
        lectureCount: data.lectureCount ?? 0,
        totalDurationSeconds: data.totalDurationSeconds ?? 0,
      },
    });
  }

  updateDetails(id: string, data: CourseDetailsPatch, executor?: unknown): Promise<Course> {
    // `undefined` is Prisma's "leave alone" and `null` is "clear it", which is exactly the
    // PATCH semantics the schema encodes — so the patch is passed through unmapped.
    return this.client(executor).course.update({ where: { id }, data });
  }

  updatePricing(id: string, data: CoursePricing, executor?: unknown): Promise<Course> {
    return this.client(executor).course.update({ where: { id }, data });
  }

  /**
   * `publishedAt` is set on the first publish and never moved again — it is the catalog's
   * sort key, and a republished course jumping to the top of "newest" is a bug, not a
   * feature.
   */
  async setStatus(id: string, status: CourseStatus, executor?: unknown): Promise<Course> {
    const db = this.client(executor);
    if (status !== 'PUBLISHED') {
      return db.course.update({ where: { id }, data: { status } });
    }

    // Two statements because the stamp is conditional and SQL has no "set if null" in an
    // UPDATE Prisma can express. `updateMany` with `publishedAt: null` in the predicate
    // touches zero rows on a republish, which is precisely the wanted behaviour.
    await db.course.updateMany({
      where: { id, publishedAt: null },
      data: { publishedAt: new Date() },
    });
    return db.course.update({ where: { id }, data: { status } });
  }

  async insertSections(
    courseId: string,
    sections: NewSection[],
    executor?: unknown,
  ): Promise<void> {
    const db = this.client(executor);
    for (const section of sections) {
      await db.section.create({
        data: {
          courseId,
          title: section.title,
          position: section.position,
          lectures: { create: section.lectures },
        },
      });
    }
  }
}

type ListRow = Prisma.CourseGetPayload<{ select: typeof LIST_SELECT }>;

/**
 * Prisma returns `Decimal` for `ratingAverage` and `Date` for `publishedAt`; the wire
 * contract in `@masternova/shared` is a number and an ISO string. The conversion happens
 * once, here, rather than in every caller.
 */
function toListItem(row: ListRow): CourseListItem {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    level: row.level,
    language: row.language,
    status: row.status,
    thumbnailKey: row.thumbnailKey,
    ratingAverage: Number(row.ratingAverage),
    ratingCount: row.ratingCount,
    enrollmentCount: row.enrollmentCount,
    lectureCount: row.lectureCount,
    totalDurationSeconds: row.totalDurationSeconds,
    priceMinor: row.priceMinor,
    listPriceMinor: row.listPriceMinor,
    currency: row.currency,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    instructor: row.instructor,
    category: row.category,
  };
}
