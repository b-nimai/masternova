import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  CourseEditEntry,
  ICourseEditLog,
  NewCourseEdit,
} from './edit-log.repository.interface';

@Injectable()
export class PrismaCourseEditLog implements ICourseEditLog {
  constructor(private readonly prisma: PrismaService) {}

  private client(executor?: unknown): PrismaClient {
    return (executor as PrismaClient) ?? this.prisma;
  }

  async record(edit: NewCourseEdit, executor?: unknown): Promise<void> {
    await this.client(executor).courseEdit.create({
      data: {
        courseId: edit.courseId,
        actorId: edit.actorId,
        kind: edit.command.kind,
        command: edit.command as unknown as Prisma.InputJsonValue,
        inverse: edit.inverse as unknown as Prisma.InputJsonValue,
        version: edit.version,
      },
    });
  }

  /**
   * Ordered by `version`, not `createdAt`.
   *
   * Two edits can share a timestamp — `now()` is transaction-start time in Postgres, so two
   * autosaves a millisecond apart genuinely can tie — but they cannot share a version,
   * because each one claimed it with a conditional update. Popping the wrong one would undo
   * an edit out of order and apply an inverse computed against a state that no longer holds.
   */
  async peek(courseId: string, executor?: unknown): Promise<CourseEditEntry | null> {
    const row = await this.client(executor).courseEdit.findFirst({
      where: { courseId, undoneAt: null },
      orderBy: { version: 'desc' },
      select: { id: true, inverse: true },
    });
    return row ? { id: row.id, inverse: row.inverse } : null;
  }

  async markUndone(id: string, executor?: unknown): Promise<void> {
    await this.client(executor).courseEdit.update({
      where: { id },
      data: { undoneAt: new Date() },
    });
  }

  async hasUndoable(courseId: string, executor?: unknown): Promise<boolean> {
    const row = await this.client(executor).courseEdit.findFirst({
      where: { courseId, undoneAt: null },
      select: { id: true },
    });
    return row !== null;
  }
}
