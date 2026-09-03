import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Currency } from '@masternova/db';
import { commerceConfig } from '../../../config/configuration';
import {
  PaymentEventType,
  type CreateProviderOrderInput,
  type IPaymentProvider,
  type ProviderEvent,
  type ProviderOrder,
  type ProviderRefund,
} from './payment-provider.interface';
import { PaymentProviderException, WebhookSignatureException } from '../../../common/exceptions';

const API = 'https://api.razorpay.com/v1';

/**
 * A parsed provider payload: JSON, so unknown-shaped by definition.
 *
 * `unknown` rather than `any`, and read through `pick`/`str` below — every field this
 * adapter takes from Razorpay is one it must not assume is there. The whole reason the
 * Adapter exists is that this shape is theirs to change without telling us.
 */
type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null ? (value as Json) : undefined;

const str = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : String(value);

const num = (value: unknown): number | undefined =>
  value === undefined || value === null ? undefined : Number(value);

/**
 * Razorpay's own event names, mapped to the four this domain acts on.
 *
 * Everything absent from this table becomes `Ignored` — recorded for the audit trail and
 * then dropped. That default is deliberate: Razorpay adds event types without asking, and
 * an adapter that threw on an unknown one would turn a new provider feature into a webhook
 * endpoint returning 500 and a provider retrying it for days.
 */
const EVENT_MAP: Record<string, PaymentEventType> = {
  'payment.captured': PaymentEventType.PaymentCaptured,
  'payment.failed': PaymentEventType.PaymentFailed,
  'refund.processed': PaymentEventType.RefundProcessed,
};

/**
 * Razorpay behind {@link IPaymentProvider} (**Adapter**).
 *
 * Nothing above this file knows that amounts are called `amount`, that our order id travels
 * as `receipt`, or that the useful fields sit three levels deep under
 * `payload.payment.entity`. That translation is the whole job.
 *
 * **`fetch`, not the `razorpay` SDK.** Four calls are needed and two of them are HMAC
 * arithmetic; the SDK brings a dependency, its own error shapes and its own retry policy to
 * wrap. It is also the reason this class can be unit-tested by stubbing one function.
 */
@Injectable()
export class RazorpayAdapter implements IPaymentProvider {
  readonly name = 'razorpay';
  private readonly logger = new Logger(RazorpayAdapter.name);

  constructor(
    @Inject(commerceConfig.KEY) private readonly config: ConfigType<typeof commerceConfig>,
  ) {}

  async createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    const body = await this.call('/orders', {
      amount: input.amountMinor,
      currency: input.currency,
      // Ours. Makes their dashboard searchable by our order id, which is the first thing
      // support asks for.
      receipt: input.orderId,
      notes: input.notes ?? {},
    });

    const providerOrderId = str(body.id);
    if (!providerOrderId) {
      // `?? ''` here would write an empty string into a unique column: the first such order
      // takes `''`, and every later checkout then dies on the constraint *after* its own
      // order row and coupon redemption have already committed.
      throw new PaymentProviderException('razorpay /orders returned no order id');
    }

    return {
      providerOrderId,
      publicKey: this.config.razorpayKeyId,
      amountMinor: num(body.amount) ?? input.amountMinor,
      currency: input.currency,
    };
  }

  /**
   * **The signature is checked over the raw bytes, before anything is parsed.**
   *
   * Re-serialising a parsed object and signing that would fail on key order, unicode
   * escaping and number formatting — and "it mostly works" on a signature check means it
   * fails open on exactly the payloads an attacker chooses. `rawBody: true` in `main.ts`
   * exists for this.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): ProviderEvent {
    const presented = headers['x-razorpay-signature'];
    if (!presented) throw new WebhookSignatureException('missing signature header');

    if (!this.config.razorpayWebhookSecret) {
      // Unverified is not the same as unconfigured. Refusing everything is the safe answer
      // for an endpoint anyone on the internet can call.
      throw new WebhookSignatureException('webhook secret is not configured');
    }

    const expected = createHmac('sha256', this.config.razorpayWebhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!constantTimeEquals(expected, presented)) {
      throw new WebhookSignatureException('signature mismatch');
    }

    return this.normalise(JSON.parse(rawBody.toString('utf8')) as Json);
  }

  async refund(input: {
    providerPaymentId: string;
    amountMinor: number;
    reason?: string;
    idempotencyKey: string;
  }): Promise<ProviderRefund> {
    const body = await this.call(
      `/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      {
        amount: input.amountMinor,
        notes: input.reason ? { reason: input.reason } : {},
      },
      // Razorpay honours this header, so our retry is not a second refund. The one call
      // here that moves money in the outbound direction is the one that most needs it.
      { 'X-Razorpay-Idempotency-Key': input.idempotencyKey },
    );

    const providerRefundId = str(body.id);
    if (!providerRefundId) {
      // Same reason as `createOrder`, with a worse failure: an empty key makes the refund
      // upsert land on an unrelated order's row.
      throw new PaymentProviderException('razorpay refund returned no refund id');
    }

    return {
      providerRefundId,
      amountMinor: num(body.amount) ?? input.amountMinor,
      status: body.status === 'processed' ? 'PROCESSED' : 'PENDING',
    };
  }

  /**
   * Razorpay's envelope, flattened.
   *
   * The event id comes from the `x-razorpay-event-id` header in transport, but Razorpay also
   * repeats it in the body for `refund` events and omits it for others — so it is taken from
   * the body when present and synthesised from the entity id when not. Either way it must be
   * **stable across redeliveries**, because it is the dedupe key.
   */
  private normalise(body: Json): ProviderEvent {
    const eventName = str(body.event) ?? '';
    const type = EVENT_MAP[eventName] ?? PaymentEventType.Ignored;

    const payload = obj(body.payload);
    const payment = obj(obj(payload?.payment)?.entity);
    const refund = obj(obj(payload?.refund)?.entity);
    const entity = refund ?? payment;

    if (type === PaymentEventType.Ignored) {
      this.logger.debug(`ignoring unmapped razorpay event ${eventName}`);
    }

    return {
      // `${event}:${entityId}` rather than a random id: it is identical on every redelivery
      // of the same event, which is exactly what the unique constraint needs.
      providerEventId: str(body.id) ?? `${eventName}:${str(entity?.id) ?? 'unknown'}`,
      type,
      providerOrderId: str(payment?.order_id),
      providerPaymentId: str(payment?.id),
      providerRefundId: str(refund?.id),
      amountMinor: num(entity?.amount),
      currency: str(entity?.currency) as Currency | undefined,
      method: str(payment?.method),
      failureCode: str(payment?.error_code),
      raw: body,
    };
  }

  private async call(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Json> {
    const auth = Buffer.from(
      `${this.config.razorpayKeyId}:${this.config.razorpayKeySecret}`,
    ).toString('base64');

    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.providerTimeoutMs),
      });
    } catch (error) {
      // A timeout on a call that may have succeeded at the far end. Distinguished from a
      // refusal because the two demand different handling: this one must be retried against
      // an idempotency key, never treated as "it did not happen".
      throw new PaymentProviderException(
        `razorpay ${path} did not respond: ${(error as Error).message}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new PaymentProviderException(
        `razorpay ${path} returned ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    return JSON.parse(text) as Json;
  }
}

/** Length-checked first: `timingSafeEqual` throws on a mismatch rather than returning false. */
function constantTimeEquals(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
