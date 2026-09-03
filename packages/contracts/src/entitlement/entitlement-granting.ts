/**
 * The entitlement module's public face, for the modules that grant and revoke access.
 *
 * **Why this lives in `contracts` rather than being imported from the module.** Commerce
 * needs to grant an entitlement inside the order's transaction, and a module may only see
 * another through its public interface here (CLAUDE.md §4). Without this token, commerce
 * would `import { EntitlementService } from '../entitlement/...'` — the boundary violation
 * ADR-0001 exists to prevent, and the one the `boundaries` lint rule fails the build over.
 *
 * It is deliberately **three methods**, not the whole service. Commerce has no business
 * asking whether a learner may play a lecture; the decision half of entitlement is none of
 * its concern (CLAUDE.md §1 I).
 */

export const ENTITLEMENT_GRANTING = Symbol('ENTITLEMENT_GRANTING');

export type EntitlementGrantSource = 'PURCHASE' | 'FREE_ENROLLMENT' | 'MANUAL_GRANT';

export interface EntitlementKeyRef {
  readonly userId: string;
  readonly courseId: string;
}

export interface GrantAccessInput {
  readonly userId: string;
  readonly courseId: string;
  readonly source: EntitlementGrantSource;
  readonly orderId?: string | null;
  readonly expiresAt?: Date | null;
}

export interface EntitlementGranting {
  /**
   * Idempotent by construction — one row per `(userId, courseId)`, so a redelivered
   * `order.paid` upserts rather than inserting a second entitlement no revoke would find.
   *
   * `executor` joins the caller's transaction. Passing it is what makes the grant commit
   * with the order that paid for it rather than as a second, separately-failing write.
   */
  grant(input: GrantAccessInput, executor?: unknown): Promise<void>;

  /** Refund and chargeback: revoke everything one order paid for. */
  revokeByOrder(
    orderId: string,
    reason: string,
    executor?: unknown,
  ): Promise<readonly EntitlementKeyRef[]>;

  /**
   * Drop the cache for these pairs. **Called after the transaction commits, never inside
   * it** — a cache dropped mid-transaction is re-filled with the pre-write row by any
   * concurrent read, and the revoke silently keeps working for the cache's whole TTL.
   */
  forget(keys: readonly EntitlementKeyRef[]): Promise<void>;
}
