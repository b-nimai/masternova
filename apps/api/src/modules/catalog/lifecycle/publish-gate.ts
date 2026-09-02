import type { PublishProblem, WizardStep } from '@masternova/shared';

/**
 * The publish gate: everything that must be true before a course may be seen by a learner.
 *
 * **The force.** A half-finished course reaching the catalog is not a cosmetic problem — it
 * is a course somebody pays for and then finds has three empty sections. The checks
 * therefore have to run on the server, at the moment of the transition, against the row as
 * it actually is. Client-side wizard validation is a convenience; it is not a gate.
 *
 * **Why a list of named requirements rather than one `canPublish()` function.** Adding a
 * rule is adding an entry, with zero edits to the engine (CLAUDE.md §1 O) — and every rule
 * carries a stable `code` and the wizard step it belongs to, which is what turns the gate
 * from a 409 with a sentence in it into a per-step checklist the UI can render *before* the
 * instructor presses publish. The same list produces both answers, so the checklist and the
 * gate can never disagree.
 *
 * **Not a Specification.** These are rules about one aggregate held in memory, never
 * compiled to SQL, so they need none of `CourseSpecification`'s two-representation
 * machinery — and giving them a `toWhere()` nothing calls would be exactly the speculative
 * generality §3 forbids.
 *
 * Pure: no injection, no I/O, no database. That is what lets the whole gate be tested from
 * literals.
 */

/** The shape the gate judges. Structural, so a Prisma row satisfies it with no mapper. */
export interface ReadinessSnapshot {
  readonly title: string;
  readonly subtitle: string | null;
  readonly description: string;
  readonly categoryId: string | null;
  readonly thumbnailKey: string | null;
  readonly priceSetAt: Date | null;
  readonly sections: readonly {
    readonly title: string;
    readonly lectures: readonly {
      readonly title: string;
      readonly kind: 'VIDEO' | 'ARTICLE';
      readonly isPreview: boolean;
      readonly assetId: string | null;
      readonly articleBody: string | null;
    }[];
  }[];
}

export interface PublishRequirement {
  readonly code: string;
  readonly step: WizardStep;
  readonly message: string;
  isMetBy(course: ReadinessSnapshot): boolean;
}

const MIN_DESCRIPTION = 100;

const requirement = (
  code: string,
  step: WizardStep,
  message: string,
  isMetBy: (course: ReadinessSnapshot) => boolean,
): PublishRequirement => ({ code, step, message, isMetBy });

const filled = (value: string | null): boolean => (value ?? '').trim().length > 0;

/**
 * Ordered as the wizard is, so `problems[0]` is the first thing to go and fix.
 *
 * `MEDIA_MISSING` is the narrow version of "all media READY": catalog can see that a video
 * lecture has an `assetId`, but not whether transcoding finished, because the media module
 * (task 1.6) does not exist yet and a cross-context readiness query is its contract to
 * define — not one catalog should invent and then have to change. When 1.6 lands, this
 * requirement's predicate widens and nothing else in this file moves. That is the seam.
 */
export const PUBLISH_REQUIREMENTS: readonly PublishRequirement[] = [
  requirement('SUBTITLE_MISSING', 'DETAILS', 'Add a one-line subtitle.', (c) => filled(c.subtitle)),
  requirement(
    'DESCRIPTION_TOO_SHORT',
    'DETAILS',
    `Write at least ${MIN_DESCRIPTION} characters of description.`,
    (c) => c.description.trim().length >= MIN_DESCRIPTION,
  ),
  requirement('CATEGORY_MISSING', 'DETAILS', 'Pick a category.', (c) => c.categoryId !== null),
  requirement('THUMBNAIL_MISSING', 'DETAILS', 'Upload a course thumbnail.', (c) =>
    filled(c.thumbnailKey),
  ),

  requirement(
    'NO_SECTIONS',
    'CURRICULUM',
    'A course needs at least one section.',
    (c) => c.sections.length > 0,
  ),
  requirement('EMPTY_SECTION', 'CURRICULUM', 'Every section needs at least one lecture.', (c) =>
    c.sections.every((section) => section.lectures.length > 0),
  ),
  requirement('MEDIA_MISSING', 'CURRICULUM', 'Every video lecture needs an uploaded video.', (c) =>
    c.sections.every((section) =>
      section.lectures.every((l) => l.kind !== 'VIDEO' || l.assetId !== null),
    ),
  ),
  requirement('ARTICLE_EMPTY', 'CURRICULUM', 'Every article lecture needs a body.', (c) =>
    c.sections.every((section) =>
      section.lectures.every((l) => l.kind !== 'ARTICLE' || filled(l.articleBody)),
    ),
  ),
  /**
   * Not arbitrary product taste: the entitlement engine (task 1.8) turns ABSTAIN into ALLOW
   * for a preview lecture, so a course with none of them is one nobody can sample before
   * paying. It is also the only lecture the catalog page can actually play.
   */
  requirement(
    'NO_PREVIEW_LECTURE',
    'CURRICULUM',
    'Mark at least one lecture as a free preview.',
    (c) => c.sections.some((section) => section.lectures.some((l) => l.isPreview)),
  ),

  requirement(
    'PRICE_NOT_CONFIRMED',
    'PRICING',
    'Confirm the price. Free is a valid choice, but it has to be a choice.',
    (c) => c.priceSetAt !== null,
  ),
];

const STEP_ORDER: readonly WizardStep[] = ['DETAILS', 'CURRICULUM', 'PRICING'];

export interface Readiness {
  readonly ready: boolean;
  readonly problems: readonly PublishProblem[];
  readonly steps: readonly {
    readonly step: WizardStep;
    readonly complete: boolean;
    readonly problems: PublishProblem[];
  }[];
}

/** One pass over the requirements, presented two ways. Both answers, one source. */
export function readinessOf(course: ReadinessSnapshot): Readiness {
  const problems: PublishProblem[] = PUBLISH_REQUIREMENTS.filter(
    (rule) => !rule.isMetBy(course),
  ).map(({ code, step, message }) => ({ code, step, message }));

  return {
    ready: problems.length === 0,
    problems,
    steps: STEP_ORDER.map((step) => {
      const forStep = problems.filter((problem) => problem.step === step);
      return { step, complete: forStep.length === 0, problems: forStep };
    }),
  };
}
