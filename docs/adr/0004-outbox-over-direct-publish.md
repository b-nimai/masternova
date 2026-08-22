# ADR-0004 — Transactional outbox over publishing directly

**Status:** accepted · **Date:** 2026-08-22 · **Deciders:** Nimai

## Context

Several state changes have consequences in other bounded contexts. The load-bearing one is
payment: an order moving to PAID must enroll the learner, raise an invoice and email a
receipt. Each can fail on its own, each involves a system we do not control, and the
customer notices immediately if any is skipped.

Postgres, Razorpay and the email provider share no transaction manager, so there is no
atomic operation spanning "record the payment" and "send the receipt".

## Decision

**A transactional outbox.** The state change and one row per consequence commit in a single
Postgres transaction. A relay in the worker claims rows, dispatches them to handlers, and
marks them published.

Three details are load-bearing and each was chosen against a plausible alternative:

1. **Events are buffered in memory and written as the last statement of the same
   transaction** (`PrismaUnitOfWork`). Publishing is only reachable through the Unit of
   Work, so there is no way to write an event outside the transaction by accident.

2. **Consumers dedupe on `(eventId, handler)`, written after the handler succeeds.**
   Delivery is at-least-once; this is what makes _effects_ exactly-once. Writing the marker
   first would be at-most-once — a handler that throws would never be retried.

3. **Claiming uses `FOR UPDATE SKIP LOCKED` and pushes `availableAt` forward.** The lock
   only lasts for the claiming transaction, so `SKIP LOCKED` alone lets a second relay
   re-claim a row that is actively being delivered. Treating `availableAt` as a visibility
   deadline fixes that, and makes crash recovery automatic rather than a separate reaper.

## Consequences

**Positive.** Exactly-once effects without a distributed transaction. Producers do not know
their consumers, so adding one is additive (`CLAUDE.md` §1 O). A failing email cannot fail a
checkout. Every event is a durable, queryable audit trail of what happened and when.

**Negative.** Latency: effects are delayed by up to one poll interval (1s). Handlers must be
idempotent in their own right, which is a real constraint on everyone who writes one. The
outbox table grows and will need archival. Polling costs one indexed query per second per
replica, forever.

**Accepted risk.** A handler that is _not_ genuinely idempotent will double its effect after
a crash in the marker gap. Mitigated by making the requirement explicit in the interface
docs and by requiring a run-it-twice test for every handler (`CLAUDE.md` §6).

## Alternatives rejected

| Option                                  | Why not                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publish to the queue right after commit | The gap between commit and publish is unbounded, and a crash there loses the effect with no trace. This is the single most common way systems that believe they are reliable lose messages. |
| Two-phase commit                        | Neither the payment provider nor the email API is an XA participant. Where 2PC is possible at all, an in-doubt transaction holds locks in the database.                                     |
| CDC via Debezium reading the WAL        | Genuinely better at scale, and it is the documented migration path (`PROJECT_PLAN.md` §10 step 3). Today it means operating Kafka Connect to remove one `setInterval`.                      |
| `LISTEN`/`NOTIFY`                       | Not durable: a notification fired while no relay is connected is lost, so polling is still required as the floor. Adds a mechanism without removing one.                                    |
| Do the work inline in the request       | An SMTP outage becomes a checkout outage, and p95 checkout latency inherits the slowest downstream.                                                                                         |

## Revisit when

- Relay lag exceeds one second at p95 under normal load → shorten the interval, then move to CDC.
- The outbox exceeds ~50M rows → partition by month and archive `PUBLISHED`.
- A second service needs the same event stream → that is the CDC trigger, not a bigger relay.
