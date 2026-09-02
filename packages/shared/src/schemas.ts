import { z } from 'zod';

/**
 * The single source of truth for request/response shapes across api, worker and web
 * (CLAUDE.md §4). Never duplicate a DTO per app.
 *
 * Schemas are added here by the module that owns them, in bounded-context blocks.
 * Phase 0 carries only identity; catalog, media, commerce and the rest arrive with
 * their modules in Phase 1.
 */

/* ----------------------------- identity ----------------------------- */

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(80).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const roleSchema = z.enum(['LEARNER', 'INSTRUCTOR', 'ADMIN']);
export type Role = z.infer<typeof roleSchema>;

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: roleSchema,
  avatarUrl: z.string().url().nullable(),
  emailVerified: z.string().nullable(),
  createdAt: z.string(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
});
export type SessionSummary = z.infer<typeof sessionSchema>;

/* --------------------------- notification --------------------------- */

/**
 * Kept in step with the `NotificationCategory` Prisma enum by hand, and deliberately so:
 * `@masternova/shared` is imported by the browser bundle and must not depend on
 * `@masternova/db`, which drags in the Prisma client. The list is short, changes rarely,
 * and a drift is caught by the API's own Zod parse rather than reaching the database.
 */
export const notificationCategorySchema = z.enum([
  'ACCOUNT_SECURITY',
  'PURCHASE',
  'COURSE_ACTIVITY',
  'ENGAGEMENT',
  'PRODUCT_NEWS',
]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

/** The categories a user may switch off. The rest are part of a transaction they asked for. */
export const OPTIONAL_NOTIFICATION_CATEGORIES = [
  'COURSE_ACTIVITY',
  'ENGAGEMENT',
  'PRODUCT_NEWS',
] as const satisfies readonly NotificationCategory[];

export const optionalNotificationCategorySchema = z.enum(OPTIONAL_NOTIFICATION_CATEGORIES);

/** Absent means subscribed, so the response is always the complete list, never a sparse map. */
export const notificationPreferencesSchema = z.object({
  preferences: z.array(
    z.object({
      category: optionalNotificationCategorySchema,
      enabled: z.boolean(),
      /** False for the mandatory categories, which are not returned at all. */
      editable: z.literal(true),
    }),
  ),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferenceSchema = z.object({
  category: optionalNotificationCategorySchema,
  enabled: z.boolean(),
});
export type UpdateNotificationPreferenceInput = z.infer<typeof updateNotificationPreferenceSchema>;

/**
 * One-click unsubscribe. A POST, not a GET, because mail clients and corporate scanners
 * prefetch links — a GET that unsubscribes is a GET that unsubscribes people who never
 * clicked. RFC 8058 says the same thing, which is why `List-Unsubscribe-Post` exists.
 */
export const unsubscribeSchema = z.object({
  token: z.string().min(1),
});
export type UnsubscribeInput = z.infer<typeof unsubscribeSchema>;

/* ------------------------------ catalog ----------------------------- */

/**
 * Kept in step with the Prisma enums by hand, for the same reason as
 * `notificationCategorySchema` above: this package ships to the browser and must not
 * import `@masternova/db`, which drags in the Prisma client. A drift is caught by the
 * API's own Zod parse rather than reaching the database.
 */
export const courseStatusSchema = z.enum(['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED']);
export type CourseStatus = z.infer<typeof courseStatusSchema>;

export const courseLevelSchema = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS']);
export type CourseLevel = z.infer<typeof courseLevelSchema>;

export const currencySchema = z.enum(['INR', 'USD']);
export type Currency = z.infer<typeof currencySchema>;

export const lectureKindSchema = z.enum(['VIDEO', 'ARTICLE']);
export type LectureKind = z.infer<typeof lectureKindSchema>;

/**
 * Cursor pagination, everywhere a list is returned.
 *
 * The cursor is **opaque** on purpose: a client that parses it is a client that breaks
 * the day the sort key changes. It encodes the keyset tuple, not an offset — see ADR-0015.
 */
export const cursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/**
 * `RECENT` sorts by `updatedAt` and exists for the instructor dashboard.
 *
 * It is a separate sort rather than reusing `NEWEST` because a draft has no `publishedAt`,
 * so "newest" is undefined for exactly the rows that dashboard is made of — and because
 * `updatedAt` is what the `(instructorId, updatedAt DESC)` index serves
 * (`docs/db/indexes.md` §6.6).
 */
export const courseSortSchema = z.enum(['NEWEST', 'RATING', 'PRICE_ASC', 'PRICE_DESC', 'RECENT']);
export type CourseSort = z.infer<typeof courseSortSchema>;

export const courseListQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().min(2).max(80).optional(),
  /** Category **slug**, not id — the id is not something a URL should carry. */
  category: z.string().optional(),
  level: courseLevelSchema.optional(),
  language: z.string().optional(),
  /** Minor units, matching the wire format below. */
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  free: z.coerce.boolean().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  topic: z.string().optional(),
  sort: courseSortSchema.default('NEWEST'),
});
export type CourseListQuery = z.infer<typeof courseListQuerySchema>;

export const instructorCourseListQuerySchema = cursorQuerySchema.extend({
  status: courseStatusSchema.optional(),
});
export type InstructorCourseListQuery = z.infer<typeof instructorCourseListQuerySchema>;

/**
 * Money crosses the wire as minor units plus a currency, never a formatted string.
 * Formatting is a locale decision and belongs to the client.
 */
export const moneySchema = z.object({
  priceMinor: z.number().int().nonnegative(),
  listPriceMinor: z.number().int().nonnegative().nullable(),
  currency: currencySchema,
});

export const courseListItemSchema = moneySchema.extend({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  level: courseLevelSchema,
  language: z.string(),
  status: courseStatusSchema,
  thumbnailKey: z.string().nullable(),
  ratingAverage: z.number(),
  ratingCount: z.number().int(),
  enrollmentCount: z.number().int(),
  lectureCount: z.number().int(),
  totalDurationSeconds: z.number().int(),
  publishedAt: z.string().nullable(),
  instructor: z.object({ id: z.string(), name: z.string().nullable() }),
  category: z.object({ id: z.string(), slug: z.string(), name: z.string() }).nullable(),
});
export type CourseListItem = z.infer<typeof courseListItemSchema>;

/**
 * No `total`. Counting the matching set on every page is precisely the cost keyset
 * pagination exists to avoid; `nextCursor === null` is the end of the list. Facet counts,
 * when the UI needs them, come from Typesense in task 1.13 — a search engine counts
 * cheaply, an OLTP database does not.
 */
export const courseListResponseSchema = z.object({
  items: z.array(courseListItemSchema),
  nextCursor: z.string().nullable(),
});
export type CourseListResponse = z.infer<typeof courseListResponseSchema>;

export const lectureSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: lectureKindSchema,
  position: z.number().int(),
  isPreview: z.boolean(),
  durationSeconds: z.number().int(),
});

export const sectionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  position: z.number().int(),
  lectures: z.array(lectureSummarySchema),
});

export const courseDetailSchema = courseListItemSchema.extend({
  description: z.string(),
  topics: z.array(z.string()),
  promoVideoAssetId: z.string().nullable(),
  version: z.number().int(),
  sections: z.array(sectionSummarySchema),
});
export type CourseDetail = z.infer<typeof courseDetailSchema>;

export const createCourseSchema = z.object({
  title: z.string().trim().min(3).max(120),
  subtitle: z.string().trim().max(200).optional(),
  description: z.string().trim().max(20_000).default(''),
  language: z.string().trim().min(2).max(12).default('en'),
  level: courseLevelSchema.default('ALL_LEVELS'),
  categoryId: z.string().optional(),
  topics: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});
export type CreateCourseInput = z.infer<typeof createCourseSchema>;

/** Every field optional — this is a PATCH, and "absent" must not mean "clear it". */
export const updateCourseSchema = createCourseSchema.partial().extend({
  thumbnailKey: z.string().nullable().optional(),
  promoVideoAssetId: z.string().nullable().optional(),
});
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;

const coursePricingFields = z.object({
  priceMinor: z.number().int().nonnegative(),
  listPriceMinor: z.number().int().nonnegative().nullable().default(null),
  currency: currencySchema.default('INR'),
});

/**
 * Split into fields + refinement so the authoring block below can extend it with
 * `expectedVersion`. A `.refine()` produces a `ZodEffects`, which has no `.extend()` — so
 * the object has to stay reachable, or the cross-field rule gets copy-pasted.
 */
const withListPriceAbovePrice = (value: {
  priceMinor: number;
  listPriceMinor: number | null;
}): boolean => value.listPriceMinor === null || value.listPriceMinor >= value.priceMinor;

const listPriceMessage = {
  message: 'listPriceMinor is the struck-through "was" price and cannot be below the price',
  path: ['listPriceMinor'],
};

export const coursePricingSchema = coursePricingFields.refine(
  withListPriceAbovePrice,
  listPriceMessage,
);
export type CoursePricingInput = z.infer<typeof coursePricingSchema>;

export const categoryNodeSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const categoryTreeSchema = z.object({
  categories: z.array(categoryNodeSchema.extend({ children: z.array(categoryNodeSchema) })),
});
export type CategoryTree = z.infer<typeof categoryTreeSchema>;

/**
 * What the authoring endpoints return.
 *
 * A distinct shape from `courseListItemSchema` because it is a different view: it carries
 * the editing fields (`description`, `topics`, `version`) and omits the joined instructor
 * and category a card needs.
 *
 * It exists at all because returning the raw Prisma row is a contract violation with teeth
 * — `ratingAverage` is a `Decimal`, which serializes as `0` over HTTP but as `{d,e,s}` when
 * stored as JSON, so a replayed `Idempotency-Key` handed the caller a *different* body than
 * the original request. A mapped DTO makes the two identical by construction.
 */
export const instructorCourseSchema = moneySchema.extend({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  description: z.string(),
  language: z.string(),
  level: courseLevelSchema,
  status: courseStatusSchema,
  categoryId: z.string().nullable(),
  topics: z.array(z.string()),
  thumbnailKey: z.string().nullable(),
  promoVideoAssetId: z.string().nullable(),
  ratingAverage: z.number(),
  ratingCount: z.number().int(),
  enrollmentCount: z.number().int(),
  lectureCount: z.number().int(),
  totalDurationSeconds: z.number().int(),
  version: z.number().int(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InstructorCourse = z.infer<typeof instructorCourseSchema>;

/* ------------------------ catalog — authoring ----------------------- */

/**
 * Optimistic concurrency, on every write that changes *content*.
 *
 * The force is two open tabs, which is not a hypothetical: the wizard autosaves, so a
 * second tab left open on yesterday's state will happily PATCH a title over work done in
 * the first one. Last-write-wins loses the edit silently, which is the worst available
 * outcome. The client echoes back the `version` it rendered, and a mismatch is a 409 the
 * UI can turn into "this course changed elsewhere — reload".
 *
 * Deliberately **not** on the lifecycle transitions (`/submit`, `/publish`, `/archive`).
 * Those are not lost updates: they re-read the course and re-run the publish gate against
 * whatever it now contains, so a stale caller either publishes a course that is still
 * valid or is told exactly what is missing. Demanding a version there would make the
 * publish button in a list row — which never loaded a version — impossible to build.
 */
export const versionedSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});

export const lectureDraftSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).nullable().default(null),
  kind: lectureKindSchema.default('VIDEO'),
  isPreview: z.boolean().default(false),
  durationSeconds: z.number().int().nonnegative().default(0),
  /** Set by media (task 1.6) once an upload finishes; the wizard sends it back verbatim. */
  assetId: z.string().nullable().default(null),
  articleBody: z.string().max(100_000).nullable().default(null),
});
export type LectureDraft = z.infer<typeof lectureDraftSchema>;

/** Every field optional — the wizard PATCHes one field at a time as the instructor types. */
export const lecturePatchSchema = lectureDraftSchema.partial();
export type LecturePatch = z.infer<typeof lecturePatchSchema>;

/**
 * A curriculum edit, as a **first-class object** rather than nine endpoints.
 *
 * **The force.** The wizard needs undo, and undo needs the edit to be a value it can store,
 * invert and replay. Nine REST verbs cannot be inverted — a `DELETE /sections/:id` leaves
 * nothing behind to reverse. One command union can: it is parsed, applied, and written to
 * `CourseEdit` alongside the inverse computed at that moment.
 *
 * It is also why there is one route instead of nine, and why adding "duplicate a lecture"
 * later is a new member of this union plus a handler, with zero edits to the controller,
 * the service, or the undo path (CLAUDE.md §1 O).
 */
export const curriculumCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ADD_SECTION'), title: z.string().trim().min(1).max(160) }),
  z.object({
    kind: z.literal('RENAME_SECTION'),
    sectionId: z.string(),
    title: z.string().trim().min(1).max(160),
  }),
  z.object({ kind: z.literal('REMOVE_SECTION'), sectionId: z.string() }),
  /**
   * The whole order, not a `(id, newIndex)` pair. A partial reorder has to be reconciled
   * against a list the server re-reads, and two tabs dragging different rows then produce
   * an order neither of them asked for. Sending the list the instructor is actually looking
   * at makes the operation total, and the `expectedVersion` check rejects the stale one.
   */
  z.object({ kind: z.literal('REORDER_SECTIONS'), sectionIds: z.array(z.string()).min(1) }),
  z.object({
    kind: z.literal('ADD_LECTURE'),
    sectionId: z.string(),
    lecture: lectureDraftSchema,
  }),
  z.object({ kind: z.literal('UPDATE_LECTURE'), lectureId: z.string(), patch: lecturePatchSchema }),
  z.object({ kind: z.literal('REMOVE_LECTURE'), lectureId: z.string() }),
  z.object({
    kind: z.literal('MOVE_LECTURE'),
    lectureId: z.string(),
    toSectionId: z.string(),
    /** Zero-based index within the destination, not a `position` — positions are ours. */
    toIndex: z.number().int().nonnegative(),
  }),
]);
export type CurriculumCommand = z.infer<typeof curriculumCommandSchema>;

export const curriculumEditRequestSchema = versionedSchema.extend({
  command: curriculumCommandSchema,
});
export type CurriculumEditRequest = z.infer<typeof curriculumEditRequestSchema>;

/**
 * The two commands that exist only as inverses.
 *
 * A restore carries the ids of what it is bringing back, so undoing a removal does not
 * silently re-key the rows — a lecture id already handed to media (task 1.6) or sitting in
 * someone's progress record (1.10) must come back as itself. That is exactly why they are
 * **not** in `curriculumCommandSchema`: a client that could POST `RESTORE_LECTURE` could
 * choose its own primary keys.
 */
export const curriculumInverseSchema = z.discriminatedUnion('kind', [
  ...curriculumCommandSchema.options,
  z.object({
    kind: z.literal('RESTORE_SECTION'),
    section: z.object({
      id: z.string(),
      title: z.string(),
      position: z.number().int(),
      lectures: z.array(lectureDraftSchema.extend({ id: z.string(), position: z.number().int() })),
    }),
  }),
  z.object({
    kind: z.literal('RESTORE_LECTURE'),
    sectionId: z.string(),
    lecture: lectureDraftSchema.extend({ id: z.string(), position: z.number().int() }),
  }),
]);
export type CurriculumInverse = z.infer<typeof curriculumInverseSchema>;

export const editableLectureSchema = lectureDraftSchema.extend({
  id: z.string(),
  position: z.number().int(),
});

export const editableSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  position: z.number().int(),
  lectures: z.array(editableLectureSchema),
});

/**
 * What the wizard renders. Distinct from `courseDetailSchema`'s sections because an author
 * needs `assetId` and `articleBody`, and a learner browsing the catalog must not be handed
 * the body of an article they have not bought.
 */
export const curriculumSchema = z.object({
  courseId: z.string(),
  version: z.number().int(),
  /** Whether `POST /curriculum/undo` has anything to pop. Drives the button's disabled state. */
  canUndo: z.boolean(),
  sections: z.array(editableSectionSchema),
});
export type Curriculum = z.infer<typeof curriculumSchema>;

/**
 * The wizard's steps. The publish gate is expressed per step so the UI can put a tick next
 * to each one, rather than discovering at the end that something four screens back is
 * missing.
 */
export const wizardStepSchema = z.enum(['DETAILS', 'CURRICULUM', 'PRICING']);
export type WizardStep = z.infer<typeof wizardStepSchema>;

export const publishProblemSchema = z.object({
  /** Stable, machine-readable; the UI keys its copy off this, not off `message`. */
  code: z.string(),
  step: wizardStepSchema,
  message: z.string(),
});
export type PublishProblem = z.infer<typeof publishProblemSchema>;

export const publishReadinessSchema = z.object({
  courseId: z.string(),
  status: courseStatusSchema,
  version: z.number().int(),
  ready: z.boolean(),
  /** The transitions legal from the current state, so the UI enables buttons it can use. */
  allowedTransitions: z.array(courseStatusSchema),
  steps: z.array(
    z.object({
      step: wizardStepSchema,
      complete: z.boolean(),
      problems: z.array(publishProblemSchema),
    }),
  ),
});
export type PublishReadiness = z.infer<typeof publishReadinessSchema>;

/** The PATCH bodies, which are the content writes and therefore carry a version. */
export const updateCourseRequestSchema = updateCourseSchema.merge(versionedSchema);
export type UpdateCourseRequest = z.infer<typeof updateCourseRequestSchema>;

export const coursePricingRequestSchema = coursePricingFields
  .merge(versionedSchema)
  .refine(withListPriceAbovePrice, listPriceMessage);
export type CoursePricingRequest = z.infer<typeof coursePricingRequestSchema>;
