import { Injectable } from '@nestjs/common';
import { ABSTAIN, allow, DecisionReason, type PolicyDecision } from '../decision';
import type { EntitlementContext } from '../entitlement-context';
import type { EntitlementPolicy } from './entitlement-policy.interface';

/**
 * The ordinary path: they bought it, and the access has not lapsed.
 *
 * **Expiry is compared here rather than stored as a status.** A row that expires at midnight
 * would need something to wake up and flip it, and between midnight and that job running the
 * table would disagree with the clock — in the direction that keeps serving paid content for
 * free. A comparison against `context.now` has no such window.
 *
 * `expiresAt === null` is lifetime access, which is what every course sells today.
 */
@Injectable()
export class ActiveEntitlementPolicy implements EntitlementPolicy {
  readonly name = 'active-entitlement';

  decide(context: EntitlementContext): PolicyDecision {
    const entitlement = context.entitlement;
    if (!entitlement || entitlement.status !== 'ACTIVE') return ABSTAIN;

    // Abstain rather than deny an expired row: the learner may still reach the course
    // through a preview lecture or because it has since been made free, and a DENY here
    // would take those away from them too.
    if (entitlement.expiresAt && entitlement.expiresAt <= context.now) {
      return ABSTAIN;
    }

    return allow(DecisionReason.ActiveEntitlement);
  }
}
