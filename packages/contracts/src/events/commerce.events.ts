/**
 * Events published by commerce.
 *
 * **What is deliberately NOT here: an "enroll" event.** Granting the entitlement happens in
 * the *same transaction* as the order reaching PAID, not through the outbox — see
 * `docs/adr/0020-entitlement-grant-in-the-order-transaction.md`. These are the effects that
 * genuinely can fail independently: an invoice, an email, a search index update. An event
 * whose consumer must succeed for the system to be correct is not an event, it is a
 * transaction someone has spread over two.
 */

export const CommerceEvent = {
  /** Money captured, or a free order settled. The entitlement already exists. */
  OrderPaid: 'commerce.order.paid',
  /** Fully refunded. The entitlement has already been revoked in the same transaction. */
  OrderRefunded: 'commerce.order.refunded',
  /** Nobody paid in time; the coupon redemption it was holding has been released. */
  OrderExpired: 'commerce.order.expired',
} as const;

export type CommerceEventType = (typeof CommerceEvent)[keyof typeof CommerceEvent];

export interface OrderLineSnapshot {
  readonly courseId: string;
  readonly title: string;
  readonly unitPriceMinor: number;
  readonly discountMinor: number;
}

export interface OrderPaidPayload {
  readonly orderId: string;
  readonly userId: string;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly couponCode?: string;
  /**
   * The lines, snapshotted. Carried in the payload rather than fetched by the consumer,
   * because an invoice generated three retries later must print what was charged — and by
   * then the course could have been renamed or repriced.
   */
  readonly items: readonly OrderLineSnapshot[];
  readonly paidAt: string;
}

export interface OrderRefundedPayload {
  readonly orderId: string;
  readonly userId: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly reason?: string;
  /** What access was taken away. The email says which courses. */
  readonly courseIds: readonly string[];
  readonly refundedAt: string;
}

export interface OrderExpiredPayload {
  readonly orderId: string;
  readonly userId: string;
  readonly courseIds: readonly string[];
  readonly currency: string;
  readonly totalMinor: number;
  /**
   * Snapshotted for the same reason the receipt's lines are: the recovery email names the
   * courses, and it may render minutes or retries after the sweep. The sweeper already has
   * the rows loaded to release the redemption, so carrying them costs no extra query.
   */
  readonly items: readonly OrderLineSnapshot[];
}
