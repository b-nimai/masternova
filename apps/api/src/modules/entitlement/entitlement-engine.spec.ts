import { ABSTAIN, allow, deny, DecisionReason, Verdict } from './decision';
import { EntitlementEngine } from './entitlement-engine';
import type { EntitlementContext } from './entitlement-context';
import type { EntitlementPolicy } from './policies/entitlement-policy.interface';
import { AdminOverridePolicy } from './policies/admin-override.policy';
import { CourseOwnerPolicy } from './policies/course-owner.policy';
import { CoursePublishedPolicy } from './policies/course-published.policy';
import { FreeCoursePolicy } from './policies/free-course.policy';
import { PreviewLecturePolicy } from './policies/preview-lecture.policy';
import { ActiveEntitlementPolicy } from './policies/active-entitlement.policy';
import { RevokedEntitlementPolicy } from './policies/revoked-entitlement.policy';

const NOW = new Date('2026-09-03T12:00:00.000Z');

/** A published, paid course owned by someone else. The default the rules deviate from. */
function context(overrides: Partial<EntitlementContext> = {}): EntitlementContext {
  return {
    actor: { id: 'learner-1', role: 'LEARNER' },
    course: {
      id: 'course-1',
      instructorId: 'instructor-1',
      status: 'PUBLISHED',
      priceMinor: 249900,
      priceSetAt: new Date('2026-01-01'),
    },
    lecture: { id: 'lecture-1', isPreview: false },
    entitlement: null,
    now: NOW,
    ...overrides,
  };
}

/** The real chain, in the order the module wires it. */
const realChain = (): EntitlementPolicy[] => [
  new AdminOverridePolicy(),
  new CourseOwnerPolicy(),
  new FreeCoursePolicy(),
  new PreviewLecturePolicy(),
  new ActiveEntitlementPolicy(),
  new CoursePublishedPolicy(),
  new RevokedEntitlementPolicy(),
];

const stub = (name: string, decision: EntitlementPolicy['decide']): EntitlementPolicy => ({
  name,
  decide: decision,
});

describe('EntitlementEngine', () => {
  describe('the reduction', () => {
    /**
     * The property the whole design rests on. A refund has to beat every reason for access
     * a learner might have accumulated, *without knowing what those reasons are* — so it
     * must not depend on where the denying rule sits in the array.
     */
    it('lets DENY win over ALLOW no matter which came first', () => {
      const denyFirst = new EntitlementEngine([
        stub('deny', () => deny(DecisionReason.EntitlementRevoked)),
        stub('allow', () => allow(DecisionReason.FreeCourse)),
      ]);
      const allowFirst = new EntitlementEngine([
        stub('allow', () => allow(DecisionReason.FreeCourse)),
        stub('deny', () => deny(DecisionReason.EntitlementRevoked)),
      ]);

      for (const engine of [denyFirst, allowFirst]) {
        const decision = engine.decide(context());
        expect(decision.verdict).toBe(Verdict.Deny);
        expect(decision.reason).toBe(DecisionReason.EntitlementRevoked);
      }
    });

    it('denies when every policy abstains', () => {
      const engine = new EntitlementEngine([stub('quiet', () => ABSTAIN)]);
      const decision = engine.decide(context());

      expect(decision.verdict).toBe(Verdict.Deny);
      expect(decision.reason).toBe(DecisionReason.NoEntitlement);
      expect(decision.decidedBy).toBeUndefined();
    });

    /** Closed by default: a chain wired up empty by a bad refactor must not open the doors. */
    it('denies when the chain is empty', () => {
      expect(new EntitlementEngine([]).decide(context()).verdict).toBe(Verdict.Deny);
    });

    /** One broken rule must not become a 500 on every playback request. */
    it('treats a policy that throws as a denial rather than propagating', () => {
      const engine = new EntitlementEngine([
        stub('boom', () => {
          throw new Error('bad rule');
        }),
        stub('allow', () => allow(DecisionReason.FreeCourse)),
      ]);

      expect(engine.decide(context()).verdict).toBe(Verdict.Deny);
    });

    it('reports which policy decided, and everything that had an opinion', () => {
      const engine = new EntitlementEngine(realChain());
      const decision = engine.decide(
        context({ actor: { id: 'instructor-1', role: 'INSTRUCTOR' } }),
      );

      expect(decision.decidedBy).toBe('course-owner');
      expect(decision.considered.map((d) => d.policy)).toEqual(['course-owner']);
    });
  });

  describe('the real chain', () => {
    const engine = new EntitlementEngine(realChain());
    const verdictFor = (ctx: EntitlementContext) => engine.decide(ctx);

    it('denies a stranger looking at a paid course', () => {
      const decision = verdictFor(context());
      expect(decision.verdict).toBe(Verdict.Deny);
      expect(decision.reason).toBe(DecisionReason.NoEntitlement);
    });

    it('allows a learner who bought it', () => {
      const decision = verdictFor(context({ entitlement: { status: 'ACTIVE', expiresAt: null } }));
      expect(decision.verdict).toBe(Verdict.Allow);
      expect(decision.reason).toBe(DecisionReason.ActiveEntitlement);
    });

    it('allows anyone into a free preview lecture', () => {
      const decision = verdictFor(context({ lecture: { id: 'l', isPreview: true } }));
      expect(decision.verdict).toBe(Verdict.Allow);
      expect(decision.reason).toBe(DecisionReason.PreviewLecture);
    });

    it('allows anyone into a deliberately free course', () => {
      const decision = verdictFor(
        context({
          course: { ...context().course, priceMinor: 0, priceSetAt: new Date('2026-01-01') },
        }),
      );
      expect(decision.verdict).toBe(Verdict.Allow);
      expect(decision.reason).toBe(DecisionReason.FreeCourse);
    });

    /**
     * Zero is ambiguous in this schema: it is both "free" and "nobody has priced it yet".
     * Treating an unpriced course as free gives away a paid course whose author had not
     * reached the pricing step, which is real money.
     */
    it('does not treat an unpriced course as a free one', () => {
      const decision = verdictFor(
        context({ course: { ...context().course, priceMinor: 0, priceSetAt: null } }),
      );
      expect(decision.verdict).toBe(Verdict.Deny);
    });

    it('allows the instructor into their own unpublished draft', () => {
      const decision = verdictFor(
        context({
          actor: { id: 'instructor-1', role: 'INSTRUCTOR' },
          course: { ...context().course, status: 'DRAFT' },
        }),
      );
      expect(decision.verdict).toBe(Verdict.Allow);
      expect(decision.reason).toBe(DecisionReason.CourseOwner);
    });

    it('allows an admin anywhere', () => {
      const decision = verdictFor(
        context({
          actor: { id: 'admin-1', role: 'ADMIN' },
          course: { ...context().course, status: 'ARCHIVED' },
        }),
      );
      expect(decision.verdict).toBe(Verdict.Allow);
      expect(decision.reason).toBe(DecisionReason.Admin);
    });

    it('hides an unpublished course from a stranger, preview lecture and all', () => {
      const decision = verdictFor(
        context({
          course: { ...context().course, status: 'DRAFT' },
          lecture: { id: 'l', isPreview: true },
        }),
      );
      expect(decision.verdict).toBe(Verdict.Deny);
      expect(decision.reason).toBe(DecisionReason.CourseNotPublished);
    });

    /**
     * A course pulled from the catalog over a rights complaint. The learners who bought it
     * hold valid, unrevoked entitlements — and DENY beating ALLOW is what keeps it closed.
     */
    it('closes a course taken down after it was sold', () => {
      const decision = verdictFor(
        context({
          course: { ...context().course, status: 'ARCHIVED' },
          entitlement: { status: 'ACTIVE', expiresAt: null },
        }),
      );
      expect(decision.verdict).toBe(Verdict.Deny);
      expect(decision.reason).toBe(DecisionReason.CourseNotPublished);
    });

    it('locks out a refunded learner even from a preview lecture', () => {
      const decision = verdictFor(
        context({
          lecture: { id: 'l', isPreview: true },
          entitlement: { status: 'REVOKED', expiresAt: null },
        }),
      );
      expect(decision.verdict).toBe(Verdict.Deny);
      expect(decision.reason).toBe(DecisionReason.EntitlementRevoked);
    });

    it('locks out a refunded learner even after the course is made free', () => {
      const decision = verdictFor(
        context({
          course: { ...context().course, priceMinor: 0, priceSetAt: new Date('2026-01-01') },
          entitlement: { status: 'REVOKED', expiresAt: null },
        }),
      );
      expect(decision.verdict).toBe(Verdict.Deny);
      expect(decision.reason).toBe(DecisionReason.EntitlementRevoked);
    });

    describe('expiry', () => {
      it('allows access right up to the expiry instant', () => {
        const decision = verdictFor(
          context({
            entitlement: { status: 'ACTIVE', expiresAt: new Date(NOW.getTime() + 1000) },
          }),
        );
        expect(decision.verdict).toBe(Verdict.Allow);
      });

      /**
       * The reason has to distinguish "your access lapsed" from "you never bought this", or
       * the UI cannot offer a renewal — only a first purchase. `ActiveEntitlementPolicy`
       * abstains rather than denying (see below), so this comes from the engine's default.
       */
      it('denies once it has passed, and says so specifically', () => {
        const decision = verdictFor(context({ entitlement: { status: 'ACTIVE', expiresAt: NOW } }));
        expect(decision.verdict).toBe(Verdict.Deny);
        expect(decision.reason).toBe(DecisionReason.EntitlementExpired);
      });

      it('still says NO_ENTITLEMENT for someone who never bought it', () => {
        expect(verdictFor(context()).reason).toBe(DecisionReason.NoEntitlement);
      });

      /**
       * An expired row abstains rather than denying, so a learner whose access lapsed can
       * still watch the free preview — and can still be sold the course again.
       */
      it('still lets an expired learner watch a preview lecture', () => {
        const decision = verdictFor(
          context({
            lecture: { id: 'l', isPreview: true },
            entitlement: { status: 'ACTIVE', expiresAt: new Date(NOW.getTime() - 1000) },
          }),
        );
        expect(decision.verdict).toBe(Verdict.Allow);
        expect(decision.reason).toBe(DecisionReason.PreviewLecture);
      });
    });

    /**
     * A course-level question cannot be answered by one lecture's preview flag — otherwise
     * a whole paid course lands in someone's library because its first video is a trailer.
     */
    it('ignores previews when the question is about the course as a whole', () => {
      const decision = verdictFor(context({ lecture: undefined }));
      expect(decision.verdict).toBe(Verdict.Deny);
    });
  });
});
