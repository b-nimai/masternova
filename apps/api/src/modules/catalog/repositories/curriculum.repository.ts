import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  CurriculumAggregate,
  ICurriculumReader,
  ICurriculumWriter,
  LecturePatchRow,
  LecturePlacement,
  NewLectureRow,
  NewSectionRow,
  SectionPlacement,
} from './curriculum.repository.interface';

/**
 * The only place in `catalog` that knows sections and lectures are Prisma tables.
 *
 * Bound to both `CURRICULUM_READER` and `CURRICULUM_WRITER` with `useExisting`, for the same
 * reason `PrismaCourseRepository` is: one object, two role-shaped views (CLAUDE.md §1 I).
 */
@Injectable()
export class PrismaCurriculumRepository implements ICurriculumReader, ICurriculumWriter {
  constructor(private readonly prisma: PrismaService) {}

  private client(executor?: unknown): PrismaClient {
    return (executor as PrismaClient) ?? this.prisma;
  }

  async load(courseId: string, executor?: unknown): Promise<CurriculumAggregate> {
    const sections = await this.client(executor).section.findMany({
      where: { courseId },
      orderBy: { position: 'asc' },
      include: { lectures: { orderBy: { position: 'asc' } } },
    });

    return {
      courseId,
      sections: sections.map((section) => ({
        id: section.id,
        title: section.title,
        position: section.position,
        lectures: section.lectures.map((lecture) => ({
          id: lecture.id,
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

  async createSection(
    courseId: string,
    section: NewSectionRow,
    executor?: unknown,
  ): Promise<string> {
    const row = await this.client(executor).section.create({
      data: {
        // `id` is present only on a restore, and then it is the id the row had before it
        // was deleted — see `curriculumInverseSchema`. `undefined` lets the column default.
        id: section.id,
        courseId,
        title: section.title,
        position: section.position,
        lectures: { create: section.lectures.map(toLectureData) },
      },
      select: { id: true },
    });
    return row.id;
  }

  async renameSection(sectionId: string, title: string, executor?: unknown): Promise<void> {
    await this.client(executor).section.update({ where: { id: sectionId }, data: { title } });
  }

  async deleteSection(sectionId: string, executor?: unknown): Promise<void> {
    // Lectures go with it via `onDelete: Cascade`. Positions are deliberately NOT closed up:
    // the gaps of 10 mean the hole is harmless, and leaving it is what lets an undo put the
    // section back exactly where it was.
    await this.client(executor).section.delete({ where: { id: sectionId } });
  }

  async createLecture(
    sectionId: string,
    lecture: NewLectureRow,
    executor?: unknown,
  ): Promise<string> {
    const row = await this.client(executor).lecture.create({
      data: { sectionId, ...toLectureData(lecture) },
      select: { id: true },
    });
    return row.id;
  }

  async updateLecture(
    lectureId: string,
    patch: LecturePatchRow,
    executor?: unknown,
  ): Promise<void> {
    // Passed through unmapped: `undefined` is Prisma's "leave alone" and `null` is "clear
    // it", which is exactly the PATCH semantics `lecturePatchSchema` encodes.
    await this.client(executor).lecture.update({ where: { id: lectureId }, data: patch });
  }

  async deleteLecture(lectureId: string, executor?: unknown): Promise<void> {
    await this.client(executor).lecture.delete({ where: { id: lectureId } });
  }

  /**
   * Two passes, and the reason is the unique constraint.
   *
   * `@@unique([courseId, position])` is checked after every statement, so moving section B
   * onto position 10 while section A is still there fails — even though the finished layout
   * is perfectly legal. Postgres would allow the intermediate state under a DEFERRABLE
   * constraint, which Prisma cannot declare (and which would need raw SQL and a hand-written
   * migration to add). Parking every row on a distinct negative first sidesteps it entirely,
   * costs one extra round of UPDATEs on a handful of rows, and works for any permutation.
   */
  async resequenceSections(
    placements: readonly SectionPlacement[],
    executor?: unknown,
  ): Promise<void> {
    const db = this.client(executor);
    for (const [index, placement] of placements.entries()) {
      await db.section.update({
        where: { id: placement.sectionId },
        data: { position: -(index + 1) },
      });
    }
    for (const placement of placements) {
      await db.section.update({
        where: { id: placement.sectionId },
        data: { position: placement.position },
      });
    }
  }

  /**
   * The same two passes, and it is also how a lecture changes section.
   *
   * The reparent rides on the settle pass: by then the row is on a negative position, so it
   * can be handed a new `sectionId` and its final position in one statement without ever
   * colliding with a sibling in either section.
   */
  async resequenceLectures(
    placements: readonly LecturePlacement[],
    executor?: unknown,
  ): Promise<void> {
    const db = this.client(executor);
    for (const [index, placement] of placements.entries()) {
      await db.lecture.update({
        where: { id: placement.lectureId },
        data: { position: -(index + 1) },
      });
    }
    for (const placement of placements) {
      await db.lecture.update({
        where: { id: placement.lectureId },
        data: { sectionId: placement.sectionId, position: placement.position },
      });
    }
  }

  async refreshRollups(courseId: string, executor?: unknown): Promise<void> {
    const db = this.client(executor);
    const totals = await db.lecture.aggregate({
      where: { section: { courseId } },
      _count: { _all: true },
      _sum: { durationSeconds: true },
    });

    await db.course.update({
      where: { id: courseId },
      data: {
        lectureCount: totals._count._all,
        totalDurationSeconds: totals._sum.durationSeconds ?? 0,
      },
    });
  }
}

function toLectureData(lecture: NewLectureRow) {
  return {
    id: lecture.id,
    title: lecture.title,
    description: lecture.description,
    kind: lecture.kind,
    position: lecture.position,
    isPreview: lecture.isPreview,
    durationSeconds: lecture.durationSeconds,
    assetId: lecture.assetId,
    articleBody: lecture.articleBody,
  };
}
