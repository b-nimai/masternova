import { Injectable } from '@nestjs/common';
import { ABSTAIN, deny, DecisionReason, type PolicyDecision } from '../decision';
import { isStaff, type EntitlementContext } from '../entitlement-context';
import type { EntitlementPolicy } from './entitlement-policy.interface';

/**
 * A refunded or charged-back learner loses access, and nothing gives it back.
 *
 * **This is the policy that justifies "explicit DENY wins".** A refund must beat every other
 * reason for access the learner might have accumulated, and it must do so without knowing
 * what those reasons are — today that is a preview lecture and a course that later went
 * free, tomorrow it is a coupon or a bundle. Any design where this rule has to be *ordered*
 * correctly against the others is a design where the next `ALLOW` someone adds silently
 * refunds nobody.
 *
 * Staff are excluded for the same reason they are in `CoursePublishedPolicy`: an instructor
 * who was refunded for some other course's row must not be locked out of their own.
 */
@Injectable()
export class RevokedEntitlementPolicy implements EntitlementPolicy {
  readonly name = 'revoked-entitlement';

  decide(context: EntitlementContext): PolicyDecision {
    if (isStaff(context)) return ABSTAIN;

    return context.entitlement?.status === 'REVOKED'
      ? deny(DecisionReason.EntitlementRevoked)
      : ABSTAIN;
  }
}
