# ADR-0018 — Cache the entitlement row, not the decision

**Status:** accepted · **Date:** 2026-09-03 · **Task:** 1.8

## Context

Every playback request, every manifest fetch and every progress heartbeat asks the same
question: may this user reach this course? Answering it from Postgres on each one puts an
indexed read on the hottest path in the application, so something has to be cached under
`ent:{userId}:{courseId}`.

The obvious thing to cache is the **decision** — the engine's `ALLOW`/`DENY` — because that
is what the caller wanted. `BUILD_PLAN.md` specified it that way.

## Decision

Cache the **entitlement row**, behind `CachedEntitlementRepository` (Decorator). The policy
chain runs on every request, over an in-memory context.

## Why

A decision is a function of four things: the entitlement row, the course's publish status,
the course's price, and the lecture's preview flag. Caching it means invalidating it whenever
**any** of them changes:

| Change                                    | Would have to invalidate   |
| ----------------------------------------- | -------------------------- |
| Purchase, refund, chargeback, admin grant | that one pair              |
| Course published / unpublished / archived | every pair for that course |
| Course repriced to or from zero           | every pair for that course |
| A lecture's preview flag toggled          | every pair for that course |
| A lecture moved to another course         | two courses' worth         |

Five triggers, three of them fan-outs over an unbounded set of users, and every one of them
lives in a _different_ bounded context from the cache. The catalog module would have to know
that entitlement has a cache, which is the coupling `CLAUDE.md` §4 exists to prevent — and
the failure mode of missing one is serving paid content to somebody who should not have it,
silently, until a human notices.

The **row** has exactly three writers: `grant`, `revoke`, and `revokeByOrder`. All three are
methods on the interface being decorated, so the invalidation is in the same file as the
write and cannot be forgotten by a module that has never heard of it.

The chain itself is pure and synchronous over an already-fetched context — seven object
comparisons. Caching that would be caching arithmetic.

## Consequences

- One Redis `GET` and, on the staff path, not even that: `EntitlementService.contextFor`
  skips the lookup entirely for an admin or the course's own instructor, because no policy
  reads the row for them.
- Course-level changes take effect **immediately**, with no invalidation at all, because
  nothing about them was ever cached. Unpublishing a course closes it to every learner on
  the next request.
- A refund takes effect immediately on the happy path (the `DEL` runs in the same call) and
  within the 5-minute TTL if Redis dropped it. The TTL is the backstop for a missed
  invalidation, not the invalidation mechanism.
- **A write that joins the caller's transaction does not invalidate.** When commerce passes
  an `executor`, the row is not durable when the repository returns — a `DEL` there is
  followed by a concurrent read that finds the _pre-write_ row still committed in Postgres
  and re-caches it for the full TTL. So the transaction's owner calls `forget()` after it
  commits, through `EntitlementService.grantInTransaction` /
  `revokeByOrderInTransaction`. `forget` is on the interface rather than private to the
  cache precisely because only the transaction's owner knows when the commit happened; on
  the uncached implementation it is a no-op, which is a coherent answer and not a
  `NotSupportedError` (CLAUDE.md §1 L).
- Negative results are cached too. A stranger probing paid courses is the traffic shape the
  cache most needs to absorb, and it is the one a positive-only cache misses every time.
- Redis being unavailable degrades to Postgres rather than failing the request. A cache that
  can fail the request it was added to speed up is a liability.

## Alternatives rejected

| Option                                                  | Why not                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache the decision                                      | The invalidation fan-out above. It will be incomplete within a month, and every gap serves paid content for free.                                                                                       |
| Cache the decision with a short TTL and no invalidation | Makes a refund take up to the TTL to bite, with no way to force it. Refunds are the one case that must be immediate.                                                                                    |
| No cache                                                | An indexed Postgres read per segment fetch. Works today, and is the first thing to fall over at the traffic this project is sized for.                                                                  |
| Cache inside `PrismaEntitlementRepository`              | The subject would know it is cached. The Decorator keeps the SQL tests pointed at SQL and the invalidation tests pointed at invalidation, and makes removing the cache a one-line change in the module. |
