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
 */

export { PrismaClient, Prisma } from '@prisma/client';
export type { User, Role } from '@prisma/client';
