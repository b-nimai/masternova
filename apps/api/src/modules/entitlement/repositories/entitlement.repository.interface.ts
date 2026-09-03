import type { Entitlement, EntitlementSource } from '@masternova/db';

export const ENTITLEMENT_REPOSITORY = Symbol('ENTITLEMENT_REPOSITORY');

/** Just enough of the row for a decision. Deliberately not the whole entity (CLAUDE.md §1 I). */
export interface EntitlementSnapshot {
  readonly status: Entitlement['status'];
  readonly expiresAt: Date | null;
}

/** The pair every cache entry, every policy and every revoke is addressed by. */
export interface EntitlementKey {
  readonly userId: string;
  readonly courseId: string;
}

export interface GrantEntitlementInput {
  readonly userId: string;
  readonly courseId: string;
  readonly source: EntitlementSource;
  readonly orderId?: string | null;
  readonly expiresAt?: Date | null;
}

export interface IEntitlementRepository {
  /**
   * The read the whole engine hangs off, and the only one on the hot path.
   *
   * Returns `null` for "never had access", which is a different answer from a REVOKED row
   * and the policies treat them differently.
   */
  find(userId: string, courseId: string): Promise<EntitlementSnapshot | null>;

  /**
   * **An upsert, and that is the idempotency.** `order.paid` is delivered at least once, so
   * this runs twice for the same purchase as a matter of routine. The unique `(userId,
   * courseId)` pair turns the second call into an update of the row the first one wrote,
   * rather than a second entitlement that no revoke would ever find.
   *
   * It also re-activates: a learner who was refunded and buys again gets their row back,
   * which is why `status` and the revocation fields are cleared here.
   */
  grant(input: GrantEntitlementInput, executor?: unknown): Promise<void>;

  /** Refund, chargeback, or an administrator taking access back. Idempotent by construction. */
  revoke(userId: string, courseId: string, reason: string, executor?: unknown): Promise<void>;

  /**
   * Everything one order paid for — the refund path's only query.
   *
   * Returns the pairs it revoked rather than a count, because the caller has a cache keyed
   * on exactly those pairs to invalidate, and re-reading the rows to find out which ones
   * they were would be a second query for information this one already had.
   */
  revokeByOrder(
    orderId: string,
    reason: string,
    executor?: unknown,
  ): Promise<readonly EntitlementKey[]>;

  /**
   * Drop any cached copy of these pairs.
   *
   * **Why this is on the interface rather than private to the cache.** A write that takes an
   * `executor` is not durable when it returns — the caller's transaction has not committed —
   * so the decorator cannot safely invalidate at that moment: a concurrent read between the
   * `DEL` and the `COMMIT` re-caches the *pre-write* row for the full TTL, which is exactly
   * the staleness the cache was wrapped to prevent. Only the transaction's owner knows when
   * it committed, so only it can say when to forget.
   *
   * On an uncached implementation this is a no-op, not a `NotSupportedError` (CLAUDE.md §1
   * L): "forget what you cached" is a coherent instruction to something that caches nothing.
   */
  forget(keys: readonly EntitlementKey[]): Promise<void>;
}
