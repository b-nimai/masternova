import { Inject, Injectable } from '@nestjs/common';
import { DecisionReason, Verdict, type PolicyDecision, type VerdictType } from './decision';
import type { EntitlementContext } from './entitlement-context';
import {
  ENTITLEMENT_POLICIES,
  type EntitlementPolicy,
} from './policies/entitlement-policy.interface';

/** The decision, plus every verdict that produced it. */
export interface EntitlementDecision {
  readonly verdict: VerdictType;
  readonly reason: DecisionReason;
  /** The policy whose verdict decided it, or `undefined` when nothing had an opinion. */
  readonly decidedBy?: string;
  /** Every non-abstaining verdict, in chain order. What `explain()` is for. */
  readonly considered: readonly PolicyDecision[];
}

/**
 * Runs the policy chain and reduces it to one answer.
 *
 * **Every policy runs. There is no short-circuit, and that is the design.** The obvious
 * chain returns the first non-abstaining verdict, which makes the answer depend on the
 * order of the array — and an ordering-dependent authorization decision is one that a
 * later, correct-looking insertion silently breaks. Here the reduction is:
 *
 *   any DENY  →  DENY      (explicit denial always wins)
 *   else any ALLOW  →  ALLOW
 *   else  →  DENY, because nothing granted access
 *
 * so a new rule can never be defeated by an older `ALLOW` sitting above it. The cost is
 * that a `DENY` policy has to scope itself — see `isStaff` — and that cost is paid once,
 * visibly, in two files, rather than being spread across an ordering nobody can see.
 *
 * **Closed by default.** The fallthrough is `DENY`, not `ALLOW`. A policy that throws, a
 * chain wired up empty by a bad refactor, a context the rules did not anticipate — each of
 * those fails shut. The opposite default turns a deployment mistake into free access to
 * every paid course on the platform.
 *
 * It is a plain class over an injected array, not a linked list of handlers each holding
 * `next`. The classic Chain of Responsibility shape exists to let a handler decide whether
 * to continue; nothing here gets that choice, so the pointers would be ceremony.
 */
@Injectable()
export class EntitlementEngine {
  constructor(
    @Inject(ENTITLEMENT_POLICIES) private readonly policies: readonly EntitlementPolicy[],
  ) {}

  decide(context: EntitlementContext): EntitlementDecision {
    const considered: PolicyDecision[] = [];

    for (const policy of this.policies) {
      const decision = this.runSafely(policy, context);
      if (decision.verdict === Verdict.Abstain) continue;
      considered.push({ ...decision, policy: policy.name });
    }

    const denial = considered.find((d) => d.verdict === Verdict.Deny);
    if (denial) {
      return {
        verdict: Verdict.Deny,
        reason: denial.reason,
        decidedBy: denial.policy,
        considered,
      };
    }

    const grant = considered.find((d) => d.verdict === Verdict.Allow);
    if (grant) {
      return {
        verdict: Verdict.Allow,
        reason: grant.reason,
        decidedBy: grant.policy,
        considered,
      };
    }

    // Nothing had an opinion. Not an error — it is the answer for a stranger looking at a
    // paid course, which is the single most common decision this engine makes.
    //
    // The one distinction worth drawing in the *default* is a learner whose access lapsed.
    // `ActiveEntitlementPolicy` abstains on an expired row rather than denying, deliberately
    // — a DENY there would also take away the free preview and the course they could be
    // sold again — so without this they would be told `NO_ENTITLEMENT`, indistinguishable
    // from someone who never bought it, and the UI could not offer them a renewal.
    const expired =
      context.entitlement?.status === 'ACTIVE' &&
      context.entitlement.expiresAt !== null &&
      context.entitlement.expiresAt <= context.now;

    return {
      verdict: Verdict.Deny,
      reason: expired ? DecisionReason.EntitlementExpired : DecisionReason.NoEntitlement,
      considered,
    };
  }

  /**
   * A policy that throws is treated as a denial, not as an outage.
   *
   * The alternative is letting it propagate, which turns one broken rule into a 500 on
   * every playback request. Failing that rule shut keeps the rest of the chain meaningful
   * and keeps the failure on the safe side of the decision.
   */
  private runSafely(policy: EntitlementPolicy, context: EntitlementContext): PolicyDecision {
    try {
      return policy.decide(context);
    } catch {
      return { verdict: Verdict.Deny, reason: DecisionReason.NoEntitlement };
    }
  }
}
