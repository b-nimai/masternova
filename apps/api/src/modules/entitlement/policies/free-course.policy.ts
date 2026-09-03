import { Injectable } from '@nestjs/common';
import { ABSTAIN, allow, DecisionReason, type PolicyDecision } from '../decision';
import type { EntitlementContext } from '../entitlement-context';
import type { EntitlementPolicy } from './entitlement-policy.interface';

/**
 * A course priced at zero is open to anyone who can see it.
 *
 * **`priceSetAt` is checked, not just `priceMinor === 0`.** Zero is genuinely ambiguous in
 * this schema — it is both "this course is free" and "nobody has thought about price yet" —
 * and the difference is whether an instructor deliberately made it free. Treating an
 * unpriced course as free would give away a paid course whose author had not reached the
 * pricing step, which is real money. The publish gate (task 1.5) enforces the same
 * distinction, and this is the second place it matters.
 *
 * Enrollment still writes a `FREE_ENROLLMENT` row when the learner adds it to their library
 * (task 1.10) — that row is what makes it appear in "my courses". This policy is only about
 * whether the video may play.
 */
@Injectable()
export class FreeCoursePolicy implements EntitlementPolicy {
  readonly name = 'free-course';

  decide(context: EntitlementContext): PolicyDecision {
    const { priceMinor, priceSetAt } = context.course;
    return priceMinor === 0 && priceSetAt !== null ? allow(DecisionReason.FreeCourse) : ABSTAIN;
  }
}
