/**
 * What one policy says about one request.
 *
 * **Three outcomes, not a boolean.** `ABSTAIN` is the whole point: most policies have an
 * opinion about only one situation and none at all about the rest, and a boolean forces
 * every one of them to invent an answer for cases it knows nothing about. "This lecture is
 * not a free preview" is not a reason to deny access — it is a reason to say nothing and
 * let the next rule speak.
 */
export const Verdict = {
  Allow: 'ALLOW',
  Deny: 'DENY',
  Abstain: 'ABSTAIN',
} as const;

export type VerdictType = (typeof Verdict)[keyof typeof Verdict];

/**
 * A verdict plus the reason for it.
 *
 * The reason is **not** decoration. It is what the 403 body says, what the support ticket
 * quotes, and what `explain()` returns — and an engine that can only answer "no" is one
 * nobody can debug in production. It is a stable machine-readable code rather than a
 * sentence, so the frontend can map "COURSE_NOT_PUBLISHED" to a different screen than
 * "ENTITLEMENT_REVOKED" without parsing English.
 */
export interface PolicyDecision {
  readonly verdict: VerdictType;
  readonly reason: DecisionReason;
  /** Which policy said it. Filled in by the engine, so a policy cannot misattribute itself. */
  readonly policy?: string;
}

export const DecisionReason = {
  Admin: 'ADMIN_OVERRIDE',
  CourseOwner: 'COURSE_OWNER',
  FreeCourse: 'FREE_COURSE',
  PreviewLecture: 'PREVIEW_LECTURE',
  ActiveEntitlement: 'ACTIVE_ENTITLEMENT',

  CourseNotPublished: 'COURSE_NOT_PUBLISHED',
  EntitlementRevoked: 'ENTITLEMENT_REVOKED',
  EntitlementExpired: 'ENTITLEMENT_EXPIRED',

  /** Nothing allowed it. The default, and the one every new policy is measured against. */
  NoEntitlement: 'NO_ENTITLEMENT',
  NotApplicable: 'NOT_APPLICABLE',
} as const;

export type DecisionReason = (typeof DecisionReason)[keyof typeof DecisionReason];

/** Shorthands, so a policy body reads as the rule it encodes and not as object construction. */
export const allow = (reason: DecisionReason): PolicyDecision => ({
  verdict: Verdict.Allow,
  reason,
});

export const deny = (reason: DecisionReason): PolicyDecision => ({
  verdict: Verdict.Deny,
  reason,
});

/** One shared instance: abstaining carries no information, so it needs no allocation. */
export const ABSTAIN: PolicyDecision = {
  verdict: Verdict.Abstain,
  reason: DecisionReason.NotApplicable,
};
