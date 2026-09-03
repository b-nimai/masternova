import { Injectable } from '@nestjs/common';
import { ABSTAIN, allow, DecisionReason, type PolicyDecision } from '../decision';
import type { EntitlementContext } from '../entitlement-context';
import type { EntitlementPolicy } from './entitlement-policy.interface';

/**
 * An administrator may open anything.
 *
 * It is a policy and not a check in front of the engine so that it appears in `explain()`:
 * "allowed because ADMIN_OVERRIDE" is a materially different audit line from "allowed
 * because ACTIVE_ENTITLEMENT", and support reading a ticket needs to tell them apart.
 */
@Injectable()
export class AdminOverridePolicy implements EntitlementPolicy {
  readonly name = 'admin-override';

  decide(context: EntitlementContext): PolicyDecision {
    return context.actor.role === 'ADMIN' ? allow(DecisionReason.Admin) : ABSTAIN;
  }
}
