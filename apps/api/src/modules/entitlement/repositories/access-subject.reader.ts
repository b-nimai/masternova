import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  CourseSubject,
  IAccessSubjectReader,
  LectureWithCourse,
} from './access-subject.reader.interface';

/** The projection every policy reads. Named once so the two queries cannot drift apart. */
const COURSE_FIELDS = {
  id: true,
  instructorId: true,
  status: true,
  priceMinor: true,
  priceSetAt: true,
} as const;

@Injectable()
export class PrismaAccessSubjectReader implements IAccessSubjectReader {
  constructor(private readonly prisma: PrismaService) {}

  findCourse(courseId: string): Promise<CourseSubject | null> {
    return this.prisma.course.findUnique({ where: { id: courseId }, select: COURSE_FIELDS });
  }

  /**
   * One query, walking lecture → section → course.
   *
   * The nested `select` is what keeps it to one: Prisma compiles it to a join rather than
   * the three sequential round trips that fetching the lecture, then its section, then the
   * course would cost — on the single most frequently hit path in the application.
   */
  async lectureWithCourse(lectureId: string): Promise<LectureWithCourse | null> {
    const row = await this.prisma.lecture.findUnique({
      where: { id: lectureId },
      select: {
        id: true,
        isPreview: true,
        assetId: true,
        section: { select: { course: { select: COURSE_FIELDS } } },
      },
    });

    if (!row) return null;

    return {
      lecture: { id: row.id, isPreview: row.isPreview, assetId: row.assetId },
      course: row.section.course,
    };
  }
}
