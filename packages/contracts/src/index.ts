/**
 * Module public interfaces — the ONLY surface one bounded context may see of another
 * (CLAUDE.md §4).
 *
 * A module may import from here and nothing else of another module. If two modules need
 * each other's internals, the boundary is drawn in the wrong place — fix the boundary, do
 * not add the import. The ESLint `boundaries` rule fails the build on a violation, so this
 * is mechanical rather than aspirational.
 *
 * What belongs here: interfaces, injection-token `Symbol`s, domain-event payload types.
 * What does not: implementations, Prisma types, HTTP/DTO shapes (those are
 * `@masternova/shared`).
 */

export * from './kernel/domain-event.js';
export * from './kernel/unit-of-work.js';
export * from './events/identity.events.js';
export * from './events/media.events.js';
export * from './notification/unsubscribe-token.js';
