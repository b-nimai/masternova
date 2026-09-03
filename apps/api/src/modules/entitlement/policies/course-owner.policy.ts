import { Injectable } from '@nestjs/common';
import { ABSTAIN, allow, DecisionReason, type PolicyDecision } from '../decision';
import type { EntitlementContext } from '../entitlement-context';
import type { EntitlementPolicy } from './entitlement-policy.interface';

/**
 * An instructor may always watch their own course.
 *
 * Needed for the wizard, which previews lectures in a course that is still a draft and has
 * been bought by nobody — including its author, who cannot buy it.
 *
 * **The seam for co-instructors.** When a course grows a second teacher, this is the policy
 * that changes and the only one: it becomes a membership lookup instead of an id comparison.
 * Nothing else in the chain knows how ownership is decided.
 */
@Injectable()
export class CourseOwnerPolicy implements EntitlementPolicy {
  readonly name = 'course-owner';

  decide(context: EntitlementContext): PolicyDecision {
    return context.course.instructorId === context.actor.id
      ? allow(DecisionReason.CourseOwner)
      : ABSTAIN;
  }
}
