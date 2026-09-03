/**
 * Persistence package — owns the Prisma schema, the migration history, and the generated
 * client. Both `apps/api` and `apps/worker` depend on this; neither reaches into the
 * other's files for a schema.
 *
 * The force: the worker persists job results, so it needs the same models the API writes.
 * Leaving the schema inside `apps/api` would make the worker's build depend on another
 * app's internals — the same boundary violation CLAUDE.md §4 forbids between modules,
 * one level up. A package that owns persistence is the seam.
 *
 * Models are added here by the module that owns them, in bounded-context blocks. This
 * package deliberately exposes only the client and its generated types: no repositories,
 * no services. Repositories live with their module, behind an interface (CLAUDE.md §1 D).
 *
 * The one exception is the Unit of Work, and it is reached through its **own subpath** —
 * `@masternova/db/unit-of-work` — rather than through this barrel. That is not taste: this
 * package ships TypeScript sources, Node 24 loads them by type-stripping, and a
 * type-stripped module cannot resolve a *relative* specifier to a `.ts` file. Re-exporting
 * it here therefore crashed both apps at boot with `ERR_MODULE_NOT_FOUND` — found by
 * running the stack, not by a typecheck, which resolved it happily.
 */

export { PrismaClient, Prisma } from '@prisma/client';
export type {
  User,
  Role,
  OutboxMessage,
  OutboxStatus,
  ProcessedEvent,
  IdempotencyRecord,
  IdempotencyStatus,
  Session,
  SessionRevokeReason,
  RefreshToken,
  VerificationToken,
  VerificationPurpose,
  EmailDelivery,
  EmailDeliveryStatus,
  EmailSuppression,
  SuppressionReason,
  NotificationCategory,
  NotificationPreference,
  Course,
  CourseStatus,
  CourseLevel,
  Currency,
  Section,
  Lecture,
  LectureKind,
  Category,
  CourseEdit,
  Asset,
  AssetKind,
  AssetStatus,
  UploadSession,
  UploadSessionStatus,
  PipelineStatus,
  MediaRendition,
  RenditionKind,
} from '@prisma/client';
