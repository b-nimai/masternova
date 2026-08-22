/**
 * Module public interfaces — the ONLY surface one bounded context may see of another
 * (CLAUDE.md §4).
 *
 * The rule this package exists to enforce: a module may import another module's public
 * interface from here, and nothing else. If two modules need each other's internals, the
 * boundary is drawn in the wrong place — fix the boundary, do not add the import. The
 * ESLint `boundaries` rule fails the build on a violation, so this is mechanical rather
 * than aspirational.
 *
 * What belongs here: interfaces, injection-token `Symbol`s, domain-event payload types,
 * and the enums those reference.
 *
 * What does NOT belong here: implementations, Prisma types, HTTP/DTO shapes (those live in
 * `@masternova/shared`), or anything that would make one context depend on another's ORM.
 *
 * Populated in Phase 1 as each module publishes its interface. Deliberately empty in
 * Phase 0 — the seam exists before there is anything to put through it, which is the
 * point: it is cheaper to keep a boundary than to introduce one later.
 */

export {};
