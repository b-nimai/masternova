# ADR-0021 — Dedupe payment webhooks on the provider's event id, claim-before-process

**Status:** accepted · **Date:** 2026-09-03 · **Task:** 1.9

## Context

Payment providers guarantee **at-least-once** delivery and retry aggressively on any
non-2xx. Razorpay redelivers with backoff for up to 24 hours. So the same
`payment.captured` will arrive twice, and under a slow response it will arrive twice
_concurrently_.

Each delivery, unguarded, grants an entitlement, records a payment, raises
`commerce.order.paid` and sends a receipt.

Three separate hazards travel together: duplicates, arrival **before** the browser redirect,
and arrival **out of order** (a refund overtaking its capture).

## Decision

- A `ProviderWebhookEvent` row with `@@unique([provider, providerEventId])`.
- **The insert is the claim**, taken before any processing. Losing the insert means somebody
  else has this event; return without doing anything.
- Order lookup is by `providerOrderId`, which is written before the learner is ever sent to
  the payment page.
- No re-ordering buffer, no sequence numbers. **The state machine handles ordering.**

## Why

**Claim-before-process, not check-then-process.** Reading "have I seen this?" and then
inserting leaves a window in which two concurrent redeliveries both find nothing and both
proceed. Letting the unique constraint arbitrate closes it, because exactly one INSERT can
win. This is the same shape as `IdempotencyRecord` on the request path and as
`UploadSession.COMPLETING` in task 1.6 — claim the right to act _before_ the irreversible
effect, never after.

**Webhook before redirect needs no special handling, and that is the point.** The provider
usually calls back before the browser returns. Nothing waits for the redirect: the webhook is
the source of truth for whether money moved, and the redirect only shows the learner a
result. Because `providerOrderId` is set at checkout, the callback can always find its order.

**Out-of-order arrival is answered by the forward-only machine.** `refund.processed` can
overtake `payment.captured`. There is no edge from `AWAITING_PAYMENT` to `REFUNDED`, so the
early refund is a no-op — and the provider's own retry redelivers it once the order is `PAID`,
where the edge exists. Relying on the machine rather than on ordering is exactly why it is an
explicit edge list: "what can happen next" is a lookup, not an inference.

**Idempotency is layered, not single.** Even if a redelivery slips past the dedupe — the
provider _can_ issue a different event id for the same fact — the conditional
`UPDATE ... WHERE status = 'AWAITING_PAYMENT'` matches no row the second time, and
`Entitlement`'s unique `(userId, courseId)` makes the grant an upsert. Three independent
mechanisms, any one of which is sufficient.

## Consequences

- Every webhook is stored, processed or not. That is the audit trail, and the payload is
  what a replay tool would use.
- **The endpoint returns 200 for a duplicate, an ignored event type, and an event about an
  order it has never heard of.** All three mean "we have this, stop retrying". A 4xx/5xx has
  the provider redelivering for days over an event from a different environment.
- The **only** non-2xx is a bad signature, which is a **400** rather than a 401 or 500:
  providers back off on 5xx and treat 4xx as terminal, and a signature that fails will fail
  on the tenth attempt too.
- An unknown event type is `Ignored`, not an error. Razorpay adds event types without asking,
  and throwing would turn a new provider feature into an endpoint returning 500.
- `ProviderWebhookEvent` grows without bound. Not a problem at this volume; the retention job
  belongs with the rest of the data-lifecycle work in Phase 5.

## Alternatives rejected

| Option                                                      | Why not                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dedupe on `providerPaymentId`                               | Several event types share one payment (`captured`, then `refunded`). The event id is the thing that identifies a delivery.                                               |
| Process, then record                                        | The window. Two concurrent redeliveries both process.                                                                                                                    |
| A re-ordering buffer keyed by a sequence number             | Razorpay has no sequence number, and buffering means holding an event and deciding when to give up on the one before it. The state machine already answers the question. |
| Trust the browser redirect and treat webhooks as a backstop | The learner can close the tab. The redirect is the unreliable one.                                                                                                       |
| Return 500 on an unknown order so the provider retries      | Retries something that will never resolve — the usual cause is a webhook URL pointed at the wrong environment.                                                           |
