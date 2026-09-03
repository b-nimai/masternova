import type { Currency } from '@masternova/db';

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface CreateProviderOrderInput {
  /** Ours. Sent as the provider's receipt/reference so their dashboard is searchable by it. */
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: Currency;
  readonly notes?: Record<string, string>;
}

export interface ProviderOrder {
  readonly providerOrderId: string;
  /** What the browser SDK needs. Public by design — it is not a secret. */
  readonly publicKey: string;
  readonly amountMinor: number;
  readonly currency: Currency;
}

export interface ProviderRefund {
  readonly providerRefundId: string;
  readonly amountMinor: number;
  readonly status: 'PENDING' | 'PROCESSED' | 'FAILED';
}

/** The provider-neutral shape of an incoming webhook, after verification. */
export interface ProviderEvent {
  readonly providerEventId: string;
  /** Normalised, not the provider's own string. See {@link PaymentEventType}. */
  readonly type: PaymentEventType;
  readonly providerOrderId?: string;
  readonly providerPaymentId?: string;
  readonly providerRefundId?: string;
  readonly amountMinor?: number;
  readonly currency?: Currency;
  readonly method?: string;
  readonly failureCode?: string;
  /** The untouched body, stored so a replay can re-derive anything this shape omitted. */
  readonly raw: unknown;
}

/**
 * The events this domain reacts to — **not** the provider's catalogue.
 *
 * Razorpay emits around forty event types. Mapping them into four is the adapter's job and
 * the reason it exists: `OrderService` must not grow a branch the day a provider renames
 * `payment.captured`, and a second provider must not force a translation table into the
 * domain.
 */
export const PaymentEventType = {
  PaymentCaptured: 'payment.captured',
  PaymentFailed: 'payment.failed',
  RefundProcessed: 'refund.processed',
  /** Anything we do not act on. Recorded for the audit trail, then ignored. */
  Ignored: 'ignored',
} as const;

export type PaymentEventType = (typeof PaymentEventType)[keyof typeof PaymentEventType];

/**
 * A payment gateway, as this domain needs it (**Adapter**).
 *
 * **The force.** Razorpay's API is shaped for Razorpay: amounts as `amount`, orders as
 * `receipt`, a webhook body wrapped twice, and errors as a `error.code` string. None of
 * that is the domain's vocabulary, and `CheckoutService` coding against it would mean a
 * second provider is a rewrite rather than a class.
 *
 * **The rule from CLAUDE.md §1 L applies here as it does to storage:** no implementation
 * may throw `NotSupportedError`. If a provider genuinely cannot do one of these, this
 * interface is wrong and should be split — a port that only sometimes works forces every
 * caller to know which provider is behind it, which is the coupling Adapter removes.
 */
export interface IPaymentProvider {
  readonly name: string;

  createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder>;

  /**
   * **Verify before parsing, always.** The body is attacker-controlled until the signature
   * over its exact bytes checks out — which is why this takes the raw buffer and not a
   * parsed object. A handler that parses first has already trusted it.
   *
   * Returns the normalised event, or throws. There is no "unverified but probably fine".
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): ProviderEvent;

  refund(input: {
    providerPaymentId: string;
    amountMinor: number;
    reason?: string;
    /** Ours, sent as the provider's idempotency key so a retried refund is not a second one. */
    idempotencyKey: string;
  }): Promise<ProviderRefund>;
}
