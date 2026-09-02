import type { CourseStatus, Role } from '@masternova/db';

/**
 * The course draft lifecycle, as **State**: `DRAFT → IN_REVIEW → PUBLISHED → ARCHIVED`.
 *
 * **The force.** "Illegal transitions must be impossible" is not a slogan here — the
 * statuses have teeth. PUBLISHED is what the public catalog query matches, ARCHIVED is what
 * stops a course being bought while its existing learners keep access, and IN_REVIEW is the
 * only place a human looks at a course before strangers pay for it. Left to `if` statements
 * spread across a service, the fifteenth caller eventually flips `status` directly and a
 * course reaches the catalog without passing the gate.
 *
 * **What varies by state, and therefore what the state object holds:** which transitions
 * exist at all, and what each one requires. So each state is an object owning its outgoing
 * edges, and the machine can only ever offer what the current state declares — there is no
 * path through this file that produces a transition the source state did not list.
 *
 * **The alternative rejected.** Textbook State is a class per state with a method per event
 * — `DraftState.publish()`, `ArchivedState.publish()`, and so on. Four states × five events
 * is twenty methods, seventeen of which would be `throw new IllegalTransition`. That is
 * ceremony, not design: the interesting content is the *edge list*, and hiding it inside
 * method bodies makes the one question anyone ever asks — "what can happen next?" — the
 * hardest one to answer. Keeping the edges as data means `allowedFrom()` is a lookup, which
 * is exactly what the wizard needs to enable its buttons.
 *
 * Pure: no injection, no I/O. The service applies the plan this file produces.
 */

export interface CourseTransition {
  readonly to: CourseStatus;
  /** The verb the API and the UI both use, e.g. `submit`. */
  readonly name: string;
  /** The domain event emitted on success. Consumed by search (1.13) and the mailer (1.3). */
  readonly event: string;
  /**
   * Whether the publish gate must pass. True on the way *in* to review and again on the way
   * to published — the course can be edited while it sits in the queue, so approving it
   * without re-checking would publish a course that was complete yesterday.
   */
  readonly requiresPublishGate: boolean;
  /**
   * Who may take this edge. `undefined` means "the owner, or an admin acting for them",
   * which is the ownership check every authoring call already makes.
   *
   * Only approval names a role. That is what makes IN_REVIEW a real state rather than a
   * decorative one: if the instructor could walk their own course from review to published,
   * the review would be a formality and the enum value would be a lie.
   */
  readonly requiresRole?: Role;
}

export interface CourseState {
  readonly status: CourseStatus;
  readonly transitions: readonly CourseTransition[];
}

const state = (status: CourseStatus, transitions: CourseTransition[]): CourseState => ({
  status,
  transitions,
});

const ARCHIVE: CourseTransition = {
  to: 'ARCHIVED',
  name: 'archive',
  event: 'catalog.course.archived',
  requiresPublishGate: false,
};

/**
 * ARCHIVED is terminal, and stays terminal.
 *
 * Un-archiving reads like a harmless feature and is not: an archived course may have been
 * taken down for a rights complaint or a refund storm, and a one-click undo puts it back on
 * sale with no second look. Restoring one is a duplicate (the Prototype, task 1.4) into a
 * fresh DRAFT, which goes through review like anything else.
 */
export const COURSE_LIFECYCLE: Readonly<Record<CourseStatus, CourseState>> = {
  DRAFT: state('DRAFT', [
    {
      to: 'IN_REVIEW',
      name: 'submit',
      event: 'catalog.course.submitted',
      requiresPublishGate: true,
    },
    ARCHIVE,
  ]),
  IN_REVIEW: state('IN_REVIEW', [
    {
      to: 'PUBLISHED',
      name: 'publish',
      event: 'catalog.course.published',
      requiresPublishGate: true,
      requiresRole: 'ADMIN',
    },
    {
      to: 'DRAFT',
      name: 'withdraw',
      event: 'catalog.course.withdrawn',
      requiresPublishGate: false,
    },
    ARCHIVE,
  ]),
  PUBLISHED: state('PUBLISHED', [
    {
      // Back to DRAFT rather than IN_REVIEW: unpublishing is how an instructor takes a
      // course down to fix something, and parking it in a review queue it did not ask to
      // enter would hide the edit behind someone else's backlog.
      to: 'DRAFT',
      name: 'unpublish',
      event: 'catalog.course.unpublished',
      requiresPublishGate: false,
    },
    ARCHIVE,
  ]),
  ARCHIVED: state('ARCHIVED', []),
};

/** What the wizard renders as enabled buttons. A lookup, because the edges are data. */
export function allowedFrom(status: CourseStatus): CourseStatus[] {
  return COURSE_LIFECYCLE[status].transitions.map((transition) => transition.to);
}

/** `undefined` when the edge does not exist — the caller decides what that means. */
export function transitionFrom(from: CourseStatus, to: CourseStatus): CourseTransition | undefined {
  return COURSE_LIFECYCLE[from].transitions.find((transition) => transition.to === to);
}
