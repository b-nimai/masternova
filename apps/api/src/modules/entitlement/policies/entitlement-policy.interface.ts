import type { PolicyDecision } from '../decision';
import type { EntitlementContext } from '../entitlement-context';

export const ENTITLEMENT_POLICIES = Symbol('ENTITLEMENT_POLICIES');

/**
 * One access rule (Strategy), and one link in the chain (Chain of Responsibility).
 *
 * **The force.** Access to a course is not one rule, it is a growing pile of them —
 * ownership, publish state, price, previews, purchases, refunds, and by task 1.11 coupons
 * and cohort windows. Written as branches in a service, each addition edits a method that
 * already works and the test matrix doubles. Written as policies, a new rule is **a new
 * class and a new line in one array** (CLAUDE.md §1 O), and the rules that were already
 * correct are not reopened to add it.
 *
 * **Deliberately synchronous.** A policy that could `await` would be a policy that could
 * query, and the first one that did would turn a fixed-cost decision into an N+1 over the
 * chain. Everything a rule needs is in the context.
 */
export interface EntitlementPolicy {
  /** Stable identifier, reported in `explain()` and in the 403 body. */
  readonly name: string;

  decide(context: EntitlementContext): PolicyDecision;
}
