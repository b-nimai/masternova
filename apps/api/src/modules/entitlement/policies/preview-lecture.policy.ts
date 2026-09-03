import { Injectable } from '@nestjs/common';
import { ABSTAIN, allow, DecisionReason, type PolicyDecision } from '../decision';
import type { EntitlementContext } from '../entitlement-context';
import type { EntitlementPolicy } from './entitlement-policy.interface';

/**
 * A lecture flagged as a free preview plays for anyone.
 *
 * This is the rule the schema comment on `Lecture.isPreview` promised: it turns an abstain
 * into an allow for a visitor who has bought nothing. It is also the only policy that reads
 * `context.lecture`, and it abstains when there is none — "may I see this course at all"
 * cannot be answered by one lecture's preview flag, and answering it anyway would put a
 * whole paid course in someone's library because its first video was a trailer.
 *
 * It does not check publish state. `CoursePublishedPolicy` already denies an unpublished
 * course to everyone outside its staff, and a `DENY` beats this `ALLOW` — so a preview
 * lecture in a draft is unreachable without this file mentioning drafts at all. That is the
 * chain doing the composing, which is the reason for having one.
 */
@Injectable()
export class PreviewLecturePolicy implements EntitlementPolicy {
  readonly name = 'preview-lecture';

  decide(context: EntitlementContext): PolicyDecision {
    return context.lecture?.isPreview ? allow(DecisionReason.PreviewLecture) : ABSTAIN;
  }
}
