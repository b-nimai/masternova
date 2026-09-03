import type { OrderStatus } from '@masternova/db';

/**
 * The order lifecycle, as **State**, kept as an edge list rather than a class per status.
 *
 * **The force.** These statuses have teeth, and every one of them is about money. `PAID` is
 * the only state that grants access; `REFUNDED` is the only one that takes it back;
 * `EXPIRED` is what releases a coupon redemption somebody else is waiting for. Left to `if`
 * statements spread across a checkout service, a webhook handler and a sweeper, the fourth
 * caller eventually writes `status = 'PAID'` directly and an order is captured twice.
 *
 * **Forward-only, and that is the invariant worth stating.** There is deliberately no edge
 * back from `PAID` to `AWAITING_PAYMENT`. A captured payment is a fact — it exists in the
 * provider's ledger and possibly in a tax filing — and "un-paying" an order is a refund,
 * which is a different event with different accounting and a different effect on the
 * learner's access.
 *
 * **Why an edge list and not `PaidState.refund()`.** Seven statuses × six events is
 * forty-two methods, thirty-five of which would be `throw new IllegalTransition`. The
 * interesting content *is* the edge list, and burying it in method bodies makes the only
 * question anyone asks — "what can happen next?" — the hardest one to answer. Same argument
 * as `course-lifecycle.ts`, and the same shape, so the two read alike.
 *
 * Pure: no injection, no I/O, no clock. The service applies the plan this file produces.
 */

export interface OrderTransition {
  readonly to: OrderStatus;
  /** The verb the API, the webhook handler and the UI all use. */
  readonly name: string;
  /**
   * The domain event emitted on success, or `undefined` where nothing downstream cares.
   *
   * Only three transitions raise one, and the omissions are deliberate: nobody needs to
   * hear that an order reached the payment page, and a cancelled order has no effect to
   * undo. An event per edge would be an outbox full of messages with no subscribers.
   */
  readonly event?: string;
  /**
   * Whether the edge may be taken by an incoming provider webhook.
   *
   * A webhook is **not** an authenticated user, and the set of things it may do is much
   * smaller than the set a service may do. Marking it here rather than checking it in the
   * handler means the restriction is visible in the same place as the transition it limits.
   */
  readonly fromWebhook: boolean;
}

export interface OrderState {
  readonly status: OrderStatus;
  readonly transitions: readonly OrderTransition[];
}

const state = (status: OrderStatus, transitions: OrderTransition[]): OrderState => ({
  status,
  transitions,
});

/** Available from both pre-payment states, so declared once. */
const CANCEL: OrderTransition = {
  to: 'CANCELLED',
  name: 'cancel',
  fromWebhook: false,
  // No event. Nothing was granted, so there is nothing to undo and nobody to tell.
};

const EXPIRE: OrderTransition = {
  to: 'EXPIRED',
  name: 'expire',
  fromWebhook: false,
  // Raised so the coupon's redemption can be released by the same mechanism a refund uses.
  event: 'commerce.order.expired',
};

const FAIL: OrderTransition = {
  to: 'FAILED',
  name: 'fail',
  fromWebhook: true,
};

const MACHINE: Record<OrderStatus, OrderState> = {
  CREATED: state('CREATED', [
    { to: 'AWAITING_PAYMENT', name: 'submit', fromWebhook: false },
    CANCEL,
    EXPIRE,
    // A free order — every item discounted to zero — never reaches a provider. It is the
    // one edge that skips AWAITING_PAYMENT, and refusing it would mean the platform could
    // not give a course away.
    { to: 'PAID', name: 'settleFree', event: 'commerce.order.paid', fromWebhook: false },
  ]),

  AWAITING_PAYMENT: state('AWAITING_PAYMENT', [
    { to: 'PAID', name: 'capture', event: 'commerce.order.paid', fromWebhook: true },
    FAIL,
    CANCEL,
    EXPIRE,
  ]),

  /**
   * Terminal apart from the refund. In particular there is **no `capture` edge back into
   * itself**: a second `payment.captured` webhook for an order that is already PAID is not
   * an error and not a second capture — the machine simply has no such edge, and the
   * handler treats "no transition" as the no-op it is.
   */
  PAID: state('PAID', [
    { to: 'REFUNDED', name: 'refund', event: 'commerce.order.refunded', fromWebhook: true },
  ]),

  FAILED: state('FAILED', []),
  CANCELLED: state('CANCELLED', []),
  EXPIRED: state('EXPIRED', []),
  REFUNDED: state('REFUNDED', []),
};

/** What can happen next. A lookup, which is what the UI needs to enable its buttons. */
export function transitionsFrom(status: OrderStatus): readonly OrderTransition[] {
  return MACHINE[status].transitions;
}

/**
 * The one way to move an order.
 *
 * Returns `undefined` rather than throwing, because "this edge does not exist" is the
 * *expected* answer on the webhook path — a redelivered capture for an order that is
 * already PAID is routine, not exceptional, and making it an exception would mean every
 * caller wraps it in a try/catch that swallows real errors too.
 */
export function transitionFor(
  status: OrderStatus,
  name: string,
  source: 'service' | 'webhook' = 'service',
): OrderTransition | undefined {
  const edge = MACHINE[status].transitions.find((t) => t.name === name);
  if (!edge) return undefined;
  if (source === 'webhook' && !edge.fromWebhook) return undefined;
  return edge;
}

/** Nothing further will happen to this order without a human. */
export function isTerminal(status: OrderStatus): boolean {
  return MACHINE[status].transitions.length === 0;
}

/** The states an unpaid order can be swept from. Read by the expiry job. */
export const EXPIRABLE_STATUSES: readonly OrderStatus[] = ['CREATED', 'AWAITING_PAYMENT'];
