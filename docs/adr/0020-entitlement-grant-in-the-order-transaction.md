# ADR-0020 — Grant entitlements in the order's transaction, not through the outbox

**Status:** accepted · **Date:** 2026-09-03 · **Task:** 1.9

## Context

`BUILD_PLAN.md` lists commerce's effects as "outbox → **enroll** + invoice + email", and
`CLAUDE.md` §4 says cross-context communication goes through domain events "wherever the
effect can fail independently (enroll, email, search index)".

So the obvious design is: order reaches `PAID` → raise `commerce.order.paid` → a consumer
grants the entitlement.

## Decision

The entitlement is granted **inside the same transaction** as the order's transition to
`PAID`. The event is still raised, and the invoice and the receipt email still consume it.

## Why

**"Can fail independently" is the test, and enrolment fails it.** The clause in §4 is a
condition, not a list — and an entitlement is not an effect of the purchase, it _is_ the
purchase. An order that is `PAID` with no entitlement is not a system that will catch up; it
is a learner who has been charged and cannot watch, for however long the relay's poll
interval and retry backoff take. That window is seconds at best and minutes when the relay is
behind, and it lands on the single worst path in the product to have a gap in.

The counter-question is what happens if the grant fails. In the same transaction, the answer
is that the order does not reach `PAID` either, the webhook returns non-2xx, and the provider
redelivers — the whole thing retries as one unit. Through the outbox, the answer is that the
order says PAID, the money is captured, and a background job is retrying something the
learner is already complaining about.

**Both writes are in the same database.** There is no distributed transaction here and no
two-phase commit — `Entitlement` and `Order` are tables in one Postgres instance. The outbox
exists to bridge a boundary that this particular pair does not cross.

**The effects that genuinely can fail independently still go through the outbox**: the
receipt email and (task 1.12) the invoice. If the receipt fails to render, nothing about the
purchase is wrong while it retries.

**Commerce still does not import entitlement's internals.** It injects
`ENTITLEMENT_GRANTING` from `packages/contracts` — three methods, published as a token. The
boundary §4 protects is the _module_ boundary, and that is intact; what is shared is a
transaction handle, which is what `executor` has been threaded through every repository for
since task 1.2.

## Consequences

- A learner who pays has access **before the HTTP response returns**. No polling, no
  "refresh in a minute".
- The capture path holds one transaction across two modules' tables. It is short — three
  statements and no I/O inside it — and no provider call happens within it.
- The entitlement **cache** is invalidated _after_ the transaction commits, never inside it
  (ADR-0018). `OrderService` collects the granted keys and calls `forget()` on the way out.
- The same argument applies in reverse to refunds: `revokeByOrder` runs in the transaction
  that writes `REFUNDED`, because an order marked refunded whose entitlement survived is a
  learner watching content they were paid back for.
- If entitlement ever moves to its own database, this becomes a saga and this ADR is
  superseded. Recorded so that day is a decision rather than a discovery.

## Alternatives rejected

| Option                                                              | Why not                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Grant in an `order.paid` consumer                                   | The window above. It is the one place in the product where eventual consistency is felt as "I paid and it does not work".                       |
| Grant in the consumer, plus an optimistic grant on the request path | Two code paths that must agree, and the second one exists only to hide the first one's latency.                                                 |
| Have the provider's redirect grant it                               | The redirect may never happen — the learner can close the tab. The webhook is the only reliable signal, which is why it is the one that grants. |
| Keep the grant in the outbox and poll faster                        | Trades a correctness property for a tuning parameter, and makes the relay's health a payment-path dependency.                                   |
