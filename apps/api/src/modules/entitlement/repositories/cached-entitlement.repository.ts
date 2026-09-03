import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../redis/redis.constants';
import type {
  EntitlementKey,
  EntitlementSnapshot,
  GrantEntitlementInput,
  IEntitlementRepository,
} from './entitlement.repository.interface';

/**
 * `ent:{userId}:{courseId}`. Flat and derivable, so an operator debugging a support ticket
 * can build the key from the two ids in the URL and read it with one `GET`.
 */
export const entitlementCacheKey = (userId: string, courseId: string): string =>
  `ent:${userId}:${courseId}`;

/**
 * Five minutes.
 *
 * The TTL is not the invalidation mechanism — every writer below deletes the key — it is
 * the **backstop for the invalidation being missed**: a revoke that raced a read, a Redis
 * failover that dropped a `DEL`, a future writer that forgets. It bounds how long a
 * refunded learner can keep watching to five minutes, which is the same window the playback
 * token already allows, so no leak outlives it.
 */
const TTL_SECONDS = 5 * 60;

/** Distinguishes "cached: no entitlement" from "not in the cache" without a second key. */
const NO_ENTITLEMENT = 'null';

/**
 * Caches the entitlement lookup (Decorator).
 *
 * **The force.** `find` runs on every playback request, every manifest fetch and every
 * progress heartbeat, and answers with a row that changes perhaps twice in its lifetime —
 * once when it is bought and once if it is refunded. It is the definition of a read-heavy,
 * write-rare lookup.
 *
 * **Why a Decorator and not a cache inside the repository.** The subject does not know it
 * is cached, so the integration tests point at the Prisma implementation and test SQL,
 * these tests point at this one and test invalidation, and neither is testing both. It is
 * also the seam the module is wired through: `ENTITLEMENT_REPOSITORY` resolves to this,
 * wrapping the real one, and taking the cache out is a one-line change to the provider.
 *
 * **What is cached, and what deliberately is not.** The *row*, not the decision. A cached
 * decision would have to be invalidated whenever a course is published, unpublished,
 * archived, repriced, or has a lecture's preview flag toggled — a fan-out of triggers that
 * will be incomplete within a month, and every gap in it serves stale access to paid
 * content. The row has exactly three writers, all of them in this file. See ADR-0018.
 */
@Injectable()
export class CachedEntitlementRepository implements IEntitlementRepository {
  private readonly logger = new Logger(CachedEntitlementRepository.name);

  constructor(
    private readonly inner: IEntitlementRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async find(userId: string, courseId: string): Promise<EntitlementSnapshot | null> {
    const key = entitlementCacheKey(userId, courseId);

    // Redis being down must not take playback down with it. A cache that can fail the
    // request it was added to speed up is a liability, so every path here falls through to
    // the database and logs.
    try {
      const cached = await this.redis.get(key);
      if (cached === NO_ENTITLEMENT) return null;
      if (cached) return revive(JSON.parse(cached) as EntitlementSnapshot);
    } catch (error) {
      this.logger.warn(`entitlement cache read failed for ${key}: ${(error as Error).message}`);
    }

    const snapshot = await this.inner.find(userId, courseId);

    // **Negative results are cached too.** Without that, a stranger hitting a paid course
    // reaches Postgres on every single request — which is exactly the traffic shape of
    // someone probing the platform, and the one the cache most needs to absorb.
    try {
      await this.redis.set(
        key,
        snapshot ? JSON.stringify(snapshot) : NO_ENTITLEMENT,
        'EX',
        TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(`entitlement cache write failed for ${key}: ${(error as Error).message}`);
    }

    return snapshot;
  }

  /**
   * **Only invalidates when the write is already durable.**
   *
   * With an `executor` the caller's transaction has not committed yet, so a `DEL` here would
   * be followed by a concurrent `find()` reading the *pre-write* row and caching it for the
   * full TTL — a refund that appears not to have happened for five minutes, which is the
   * precise failure this Decorator exists to prevent. The transaction's owner calls
   * {@link forget} after it commits; see `EntitlementService.revokeByOrderInTransaction`.
   */
  async grant(input: GrantEntitlementInput, executor?: unknown): Promise<void> {
    await this.inner.grant(input, executor);
    if (!executor) await this.forget([{ userId: input.userId, courseId: input.courseId }]);
  }

  async revoke(
    userId: string,
    courseId: string,
    reason: string,
    executor?: unknown,
  ): Promise<void> {
    await this.inner.revoke(userId, courseId, reason, executor);
    if (!executor) await this.forget([{ userId, courseId }]);
  }

  async revokeByOrder(
    orderId: string,
    reason: string,
    executor?: unknown,
  ): Promise<readonly EntitlementKey[]> {
    const revoked = await this.inner.revokeByOrder(orderId, reason, executor);
    if (!executor) await this.forget(revoked);
    return revoked;
  }

  /**
   * **Delete, never write-through.** A write-through update would publish a value computed
   * from what this process believes the row now says, and two concurrent writers would race
   * to install their own version with no way to tell which one lost. Deleting makes the
   * next read go to the database, which is the only place that actually knows.
   *
   * A failed delete is logged and swallowed rather than failing the revoke: the refund has
   * already committed, and turning a successful refund into a 500 would have the webhook
   * retry a completed operation. The TTL is what bounds the damage — see above.
   */
  async forget(keys: readonly EntitlementKey[]): Promise<void> {
    if (keys.length === 0) return;

    try {
      await this.redis.del(...keys.map((k) => entitlementCacheKey(k.userId, k.courseId)));
    } catch (error) {
      this.logger.error(
        `entitlement cache invalidation failed for ${keys.length} key(s); they expire in ${TTL_SECONDS}s: ${(error as Error).message}`,
      );
    }
  }
}

/** JSON has no Date. Without this, `expiresAt` comes back as a string and every comparison
 *  against it is `string <= Date`, which is silently false and grants expired access. */
function revive(snapshot: EntitlementSnapshot): EntitlementSnapshot {
  return {
    status: snapshot.status,
    expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
  };
}
