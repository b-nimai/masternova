# ADR-0016 — Optimistic concurrency for authoring writes, with a conditional version claim

**Status:** accepted · **Date:** 2026-08-23 · **Deciders:** Nimai

## Context

Authoring a course is not a form submit. It is a session that spans days: an instructor
types a description on Monday, uploads six videos on Wednesday, drags a lecture into another
section on Friday. The wizard **autosaves**, and the instructor leaves a tab open on a laptop
and opens another on a desktop.

That is a lost-update problem, and it is not hypothetical: the tab holding Monday's state
autosaves on Friday and quietly overwrites three days of work. Nobody sees an error. The
instructor discovers it later and cannot reproduce it, because from their side nothing
failed.

There is a second, quieter version of the same race inside one request. A curriculum edit is
several statements — read the sections, delete one, resequence the rest, recompute the
course's `lectureCount`. Two of those running interleaved produce a curriculum neither
caller asked for, and rollup counters that no longer match the rows.

Whatever is chosen here sets the pattern for every other aggregate that gets edited
concurrently — commerce's cart and order (task 1.9) most immediately.

## Decision

**Optimistic concurrency on a `version` integer column, claimed with a conditional UPDATE as
the first statement of the transaction.**

```sql
UPDATE "Course" SET version = version + 1 WHERE id = $1 AND version = $2;
```

- **1 row updated** → the claim is taken; the transaction proceeds.
- **0 rows updated** → someone got there first. The current version is read and returned as
  `409 Conflict` with `{ expectedVersion, currentVersion }` in the error envelope's
  `details`, so the client can say "this changed elsewhere — reload" rather than guessing.

Every **content** write claims: course details, pricing, and every curriculum command. The
client echoes back the `version` it rendered.

**Lifecycle transitions deliberately do not claim.** `/submit`, `/publish`, `/archive` are
not lost updates — they carry no client-side copy of the content. They re-read the course
and re-run the publish gate against whatever it now contains, so a stale caller either
publishes a course that is still valid or is told exactly what is missing. Requiring a
version there would also make the publish button in a list row — which never loaded one —
impossible to build.

**Undo does not claim either**, for the same reason: it replays a reversal the server
computed itself. It still bumps the version, so a tab holding the pre-undo state is
correctly told it is behind.

## Why the claim is the _first_ statement

This is the part worth defending in an interview. The conditional UPDATE does **two jobs in
one round trip**:

1. It validates the optimistic-concurrency token.
2. It takes the course row's **write lock** for the rest of the transaction.

So two requests that both pass the check cannot then interleave their curriculum writes — the
second blocks on the row lock until the first commits, and then fails the check it had
already passed. A read-then-compare-then-write would have neither property: it is a
time-of-check-to-time-of-use race, and it does not serialise anything.

Measured: ten concurrent commands all claiming version 0 produce **exactly one 200 and nine
409s**, and exactly one section is created.

## Alternatives rejected

| Option                                                                     | Why not                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Last-write-wins** (no token)                                             | The losing tab's work vanishes with no error. This is the failure the decision exists to prevent.                                                                                                                                                                                      |
| **`updatedAt` as the token**                                               | Timestamps tie. Postgres's `now()` is transaction-_start_ time, so two autosaves a millisecond apart genuinely can share one — and then both claims match. A monotonic counter cannot tie.                                                                                             |
| **Pessimistic lock held across the editing session** (`SELECT FOR UPDATE`) | A lock held for the length of a human editing session is a lock held until the browser crashes. It also needs a lease, an expiry and a "steal the lock" UI — three mechanisms to avoid one integer.                                                                                    |
| **Field-level merge (CRDT / operational transform)**                       | The right answer for Google-Docs-style simultaneous editing and enormously more machinery than this needs. One instructor with two tabs does not want a merge; they want to be told which one is stale.                                                                                |
| **Serializable isolation on the transaction**                              | Solves the intra-request interleave but not the cross-request lost update: two sequential autosaves minutes apart are perfectly serializable and the second still destroys the first. It also converts a clear 409 into a retryable serialization failure the client cannot interpret. |
| **A version per section / per lecture**                                    | Finer-grained conflicts, but the aggregate's invariants — position uniqueness, the rollup counters — span the whole curriculum, so a per-row token would let two "non-conflicting" edits corrupt the ordering anyway.                                                                  |

## Consequences

- **The version is part of the API contract.** Every authoring response carries it, and
  `PATCH`/curriculum bodies must echo it. `docs/api/conventions.md` records this once.
- **409 is a normal outcome, not an error condition.** The wizard has to handle it, and the
  handling is "reload and re-apply", not "show a stack trace".
- **Reads are cheap and writes are exact.** No lock is held between requests, so an
  abandoned tab costs nothing.
- **The pattern is reusable.** Commerce (task 1.9) gets the same claim on its cart and order
  rows; it will not need a second mechanism.
- **`Course.version` is now hot.** Every content write touches the same row, which serialises
  edits _per course_ — correct, and a non-issue at any plausible authoring rate (one
  instructor, occasionally two collaborators). It would matter for a document with hundreds
  of concurrent editors, which is the point at which the CRDT option stops being overkill.
  That is the named breaking point.
