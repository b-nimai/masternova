# ADR-0001 — Modular monolith over microservices

**Status:** accepted · **Date:** 2026-08-22 · **Deciders:** Nimai

## Context

Masternova has eight bounded contexts (`identity`, `catalog`, `media`, `commerce`,
`enrollment`, `engagement`, `notification`, `analytics`) and two genuinely different
resource profiles: HTTP request handling is IO-bound and steady, while ffmpeg transcoding is
CPU-bound and bursty.

The obvious-looking move for a portfolio project is microservices, because it signals
"distributed systems." The question is whether it signals _judgement_.

## Decision

**One deployable API with hard module boundaries, plus a separately-scaled worker fleet.**

Boundaries are enforced mechanically, not by convention:

- Each context is a NestJS module owning its own folder and its own Prisma models.
- A module may import another module's **public interface from `packages/contracts`** and
  nothing else. An ESLint import-boundary rule fails the build on a cross-module internal
  import (see `CLAUDE.md` §4).
- Cross-context effects that can fail independently go through **domain events + the
  transactional outbox**, not direct service calls.

The worker is a separate deployable _because of the resource profile_, not because of the
domain — it scales on queue depth while the API scales on RPS.

## Consequences

**Positive.** One transaction spans what needs to be atomic — the order state change and its
outbox rows commit together, so exactly-once _effects_ need no distributed transaction. One
deploy, one migration path, one trace without network hops. Refactoring a boundary is a
file move rather than an API version negotiation.

**Negative.** A module boundary violated in a hurry is invisible at runtime; only the lint
rule catches it. One process means one blast radius for a memory leak. Scaling is
coarse-grained on the API side.

**Mitigation.** The lint rule is in CI from Phase 0, before any module exists — boundaries
that are enforced from commit one do not rot.

## Alternatives rejected

| Option                                  | Why not                                                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microservices from day one              | Buys deployment complexity and distributed transactions in exchange for nothing at this traffic. The checkout→enroll→invoice→email path would become a saga to solve a problem a single Postgres transaction already solves. |
| Single deployable, no module boundaries | The thing every CRUD portfolio project already is. No seam to point at, and the boundaries are exactly what makes the design explainable.                                                                                    |
| Serverless functions per endpoint       | Cold starts on a video-start path with a 2 s p95 SLO; and ffmpeg does not fit the execution model.                                                                                                                           |

## The 10x answer

Splitting is planned, in this order, by **rate of change and resource profile** — see
`PROJECT_PLAN.md` §10: `media` first (CPU-bound, spot-friendly, independent deploy cadence),
then `commerce` (compliance boundary, own DB, saga replaces the local transaction). The
named breaking points are **entitlement cache invalidation fan-out** and **payout ledger
contention**.

Naming the breaking points is the point of this ADR. The decision is not "monolith good" —
it is "monolith until these two specific things break, and here is how I will know."
