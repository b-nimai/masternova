import type { Course, Entitlement, Lecture, Role } from '@masternova/db';

/**
 * Everything the chain is allowed to look at, gathered **once** before any policy runs.
 *
 * **Why the context is assembled up front rather than fetched by the policies.** Policies
 * are pure functions of this object — no repository, no `await`, no I/O. That is what makes
 * the whole engine unit-testable with no database (CLAUDE.md §6) and what keeps the cost of
 * a decision fixed: three reads, whatever the chain grows to. Policies that fetch their own
 * data give you an N+1 that scales with the number of rules, and the rule you add in month
 * four is the one that makes playback slow.
 */
export interface EntitlementContext {
  readonly actor: { readonly id: string; readonly role: Role };

  readonly course: Pick<Course, 'id' | 'instructorId' | 'status' | 'priceMinor' | 'priceSetAt'>;

  /**
   * Absent when the question is about the course as a whole ("is this in my library?")
   * rather than about one lecture. `PreviewLecturePolicy` is the only rule that reads it,
   * and it abstains when there is none — a course-level question cannot be answered by a
   * per-lecture preview flag.
   */
  readonly lecture?: Pick<Lecture, 'id' | 'isPreview'>;

  /** Null when the learner has never had access to this course. */
  readonly entitlement: Pick<Entitlement, 'status' | 'expiresAt'> | null;

  /** Injected rather than read from the clock, so expiry is testable without faking time. */
  readonly now: Date;
}

/**
 * The instructor who owns the course, or an administrator.
 *
 * Computed once here and read by the policies that need it, because **`DENY` beats `ALLOW`
 * unconditionally** — that is the property that makes the engine safe to extend, since a
 * new rule can never be defeated by an older `ALLOW` sitting above it. The cost is that
 * every `DENY` policy must scope itself: without this predicate, "the course is not
 * published" would deny the instructor access to their own draft, and no ordering of the
 * chain could rescue it.
 */
export function isStaff(context: EntitlementContext): boolean {
  return context.actor.role === 'ADMIN' || context.course.instructorId === context.actor.id;
}
