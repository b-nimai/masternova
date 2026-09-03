import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  EntitlementKey,
  EntitlementSnapshot,
  GrantEntitlementInput,
  IEntitlementRepository,
} from './entitlement.repository.interface';

@Injectable()
export class PrismaEntitlementRepository implements IEntitlementRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The transaction handle when the caller is inside a Unit of Work, else the base client. */
  private client(executor?: unknown): PrismaClient {
    return (executor as PrismaClient) ?? this.prisma;
  }

  find(userId: string, courseId: string): Promise<EntitlementSnapshot | null> {
    return this.prisma.entitlement.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { status: true, expiresAt: true },
    });
  }

  async grant(input: GrantEntitlementInput, executor?: unknown): Promise<void> {
    const granted = {
      source: input.source,
      orderId: input.orderId ?? null,
      expiresAt: input.expiresAt ?? null,
      status: 'ACTIVE' as const,
      // Cleared on purpose. A learner who was refunded and bought again is not still
      // revoked, and leaving these set would make the row read as one at a glance.
      revokedAt: null,
      revokedReason: null,
    };

    await this.client(executor).entitlement.upsert({
      where: { userId_courseId: { userId: input.userId, courseId: input.courseId } },
      create: { userId: input.userId, courseId: input.courseId, ...granted },
      update: { ...granted, grantedAt: new Date() },
    });
  }

  /**
   * `updateMany` rather than `update`, so revoking access nobody has is a no-op instead of
   * a `RecordNotFound`. The refund path is reached from a webhook that retries, and it must
   * not start failing once it has succeeded.
   */
  async revoke(
    userId: string,
    courseId: string,
    reason: string,
    executor?: unknown,
  ): Promise<void> {
    await this.client(executor).entitlement.updateMany({
      where: { userId, courseId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason },
    });
  }

  /**
   * Read-then-write, so it must be **one transaction**.
   *
   * The `updateMany` revokes by `orderId`, but the caller needs the list of pairs it touched
   * in order to invalidate their cache keys — and that list can only come from a prior read.
   * Run as two statements, a grant for the same order committing in between is revoked by
   * the update and missing from the list: revoked in the database, still cached as ACTIVE,
   * and nothing left to tell anyone. When the caller already supplies a transaction the work
   * joins theirs; otherwise one is opened here.
   */
  async revokeByOrder(
    orderId: string,
    reason: string,
    executor?: unknown,
  ): Promise<readonly EntitlementKey[]> {
    if (executor) return this.revokeByOrderIn(executor as PrismaClient, orderId, reason);

    return this.prisma.$transaction((tx) =>
      this.revokeByOrderIn(tx as PrismaClient, orderId, reason),
    );
  }

  private async revokeByOrderIn(
    client: PrismaClient,
    orderId: string,
    reason: string,
  ): Promise<readonly EntitlementKey[]> {
    const affected = await client.entitlement.findMany({
      where: { orderId, status: 'ACTIVE' },
      select: { userId: true, courseId: true },
    });

    if (affected.length === 0) return [];

    await client.entitlement.updateMany({
      where: { orderId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason },
    });

    return affected;
  }

  /** Nothing is cached here, so there is nothing to forget. */
  async forget(): Promise<void> {}
}
