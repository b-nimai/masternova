import { Injectable } from '@nestjs/common';
import { ABSTAIN, deny, DecisionReason, type PolicyDecision } from '../decision';
import { isStaff, type EntitlementContext } from '../entitlement-context';
import type { EntitlementPolicy } from './entitlement-policy.interface';

/**
 * Nobody outside the course's own staff reaches an unpublished course.
 *
 * This is the rule that makes a leaked draft URL worthless, and it covers the case an
 * entitlement row cannot: a course **taken down** after it was sold. The learners who
 * bought it hold perfectly valid, unrevoked entitlements — and `DENY` beating `ALLOW`
 * unconditionally is exactly what stops those from re-opening a course that a rights
 * complaint pulled from the catalog.
 *
 * It scopes itself to non-staff because that unconditional precedence has no exceptions:
 * an ordering trick that let the owner's `ALLOW` win here would also let some future
 * `ALLOW` defeat a refund.
 */
@Injectable()
export class CoursePublishedPolicy implements EntitlementPolicy {
  readonly name = 'course-published';

  decide(context: EntitlementContext): PolicyDecision {
    if (isStaff(context)) return ABSTAIN;

    return context.course.status === 'PUBLISHED'
      ? ABSTAIN
      : deny(DecisionReason.CourseNotPublished);
  }
}
