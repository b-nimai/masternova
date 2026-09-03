import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrderService } from '../order/order.service';
import {
  ORDER_REPOSITORY,
  type IOrderRepository,
} from '../repositories/commerce.repository.interface';
import {
  PAYMENT_PROVIDER,
  PaymentEventType,
  type IPaymentProvider,
  type ProviderEvent,
} from './payment-provider.interface';

/** Prisma's unique-constraint violation — here, the signal that we lost the dedupe race. */
const UNIQUE_VIOLATION = 'P2002';

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'deferred';

/**
 * Receives provider webhooks, exactly once each.
 *
 * Three separate hazards, and each one has its own answer here:
 *
 * **1. Duplicates.** Providers guarantee at-least-once and retry aggressively on any
 * non-2xx. `ProviderWebhookEvent` has a unique constraint on `(provider, providerEventId)`
 * and the **insert is the claim**: it happens before any processing, so the second delivery
 * loses the insert and returns without granting a second entitlement or sending a second
 * receipt. Checking-then-inserting would leave a window in which two concurrent
 * redeliveries both find nothing and both proceed.
 *
 * **2. Webhook before redirect.** The provider can call back before the learner's browser
 * returns from the payment page — in practice it usually does. Nothing here waits for the
 * browser: the webhook is the source of truth for whether money moved, and the redirect
 * merely shows the learner a result. The order is found by `providerOrderId`, which is set
 * before the learner is ever sent to the payment page.
 *
 * **3. Out-of-order arrival.** `refund.processed` can land before `payment.captured` on a
 * slow connection. There is no re-ordering buffer and no sequence number, because the state
 * machine already handles it: a refund on an order that is not PAID has no edge, so it is a
 * no-op, and the eventual capture then moves the order to PAID. What prevents *that* from
 * being wrong is the provider's own retry — it redelivers the refund, which now finds a PAID
 * order and applies. Relying on the machine rather than on ordering is the entire reason it
 * is forward-only and edge-listed.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: IPaymentProvider,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    private readonly ordering: OrderService,
  ) {}

  /**
   * Takes the **raw bytes**, because the signature is over exactly those.
   *
   * Re-serialising a parsed body and signing that fails on key order and unicode escaping —
   * and "mostly works" on a signature check means it fails open on precisely the payloads an
   * attacker chooses.
   */
  async receive(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookOutcome> {
    // Throws if it does not verify. Nothing below this line has trusted the body.
    const event = this.provider.verifyWebhook(rawBody, headers);

    const claimed = await this.claim(event);
    if (!claimed) {
      this.logger.log(`duplicate ${event.type} ${event.providerEventId}; ignoring`);
      return 'duplicate';
    }

    try {
      const outcome = await this.dispatch(event);
      await this.prisma.providerWebhookEvent.updateMany({
        where: { provider: this.provider.name, providerEventId: event.providerEventId },
        data: { processedAt: new Date(), lastError: null },
      });
      return outcome;
    } catch (error) {
      // Recorded and rethrown. The 5xx makes the provider retry — which is what we want for
      // a transient failure — and the claim row keeps the payload for a replay tool.
      await this.prisma.providerWebhookEvent.updateMany({
        where: { provider: this.provider.name, providerEventId: event.providerEventId },
        data: { lastError: (error as Error).message.slice(0, 500) },
      });
      throw error;
    }
  }

  /**
   * The claim. Returns false when somebody else already has it, or already finished it.
   *
   * A failed insert is not an error here — it is the answer.
   *
   * **The subtlety: a duplicate insert is not proof the event was handled.** The row is
   * written *before* dispatch, so a deadlock or a timeout inside the capture transaction
   * leaves a row with `processedAt = null`. Treating the provider's retry as a plain
   * duplicate would answer 200 and drop it — money captured at the gateway, order stuck in
   * `AWAITING_PAYMENT`, no entitlement, no receipt, and the provider satisfied enough to
   * stop retrying. So a retry may **re-claim** a row that is unprocessed *and* carries a
   * `lastError`, which is what distinguishes "the previous attempt finished and failed"
   * from "another replica is holding it right now".
   *
   * Clearing `lastError` in the WHERE clause is what makes the re-claim safe under
   * concurrency: it is a conditional UPDATE, so fifty simultaneous redeliveries of a failed
   * event produce exactly one winner and forty-nine no-ops — the same property the first
   * claim gets from the unique constraint.
   */
  private async claim(event: ProviderEvent): Promise<boolean> {
    try {
      await this.prisma.providerWebhookEvent.create({
        data: {
          provider: this.provider.name,
          providerEventId: event.providerEventId,
          type: event.type,
          payload: event.raw as object,
        },
      });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      return this.reclaimFailed(event);
    }
  }

  /** Takes back a delivery whose previous attempt threw. Exactly one caller can win. */
  private async reclaimFailed(event: ProviderEvent): Promise<boolean> {
    const { count } = await this.prisma.providerWebhookEvent.updateMany({
      where: {
        provider: this.provider.name,
        providerEventId: event.providerEventId,
        processedAt: null,
        lastError: { not: null },
      },
      data: { lastError: null },
    });

    if (count > 0) {
      this.logger.warn(`retrying ${event.type} ${event.providerEventId} after a failed attempt`);
    }
    return count > 0;
  }

  private async dispatch(event: ProviderEvent): Promise<WebhookOutcome> {
    switch (event.type) {
      case PaymentEventType.PaymentCaptured:
        return this.onCaptured(event);
      case PaymentEventType.PaymentFailed:
        return this.onFailed(event);
      case PaymentEventType.RefundProcessed:
        return this.onRefunded(event);
      default:
        // Recorded above for the audit trail, then dropped. Providers add event types
        // without asking, and throwing on an unknown one would have them retry for days.
        return 'ignored';
    }
  }

  private async onCaptured(event: ProviderEvent): Promise<WebhookOutcome> {
    const order = await this.findOrder(event);
    if (!order) return 'deferred';

    await this.recordPayment(event, order.id, 'CAPTURED');

    const outcome = await this.ordering.capture(order.id, {
      paidAt: new Date(),
      source: 'webhook',
    });

    // `applied: false` means the order was already PAID — a redelivery that beat the dedupe
    // because the provider issued it a *different* event id, which happens. Not an error.
    return outcome.applied ? 'processed' : 'duplicate';
  }

  private async onFailed(event: ProviderEvent): Promise<WebhookOutcome> {
    const order = await this.findOrder(event);
    if (!order) return 'deferred';

    await this.recordPayment(event, order.id, 'FAILED');
    const outcome = await this.ordering.apply(order.id, 'fail', {
      reason: event.failureCode ?? 'provider declined',
      source: 'webhook',
    });
    return outcome.applied ? 'processed' : 'duplicate';
  }

  private async onRefunded(event: ProviderEvent): Promise<WebhookOutcome> {
    const order = await this.findOrder(event);
    if (!order) return 'deferred';

    await this.recordRefund(event, order.id);

    const outcome = await this.ordering.refund(order.id, {
      reason: 'provider refund',
      source: 'webhook',
    });
    return outcome.applied ? 'processed' : 'duplicate';
  }

  /**
   * The order this event is about, or `undefined`.
   *
   * `deferred` rather than an error, and the difference is operational: an event for an
   * order we have never heard of is almost always a webhook from another environment
   * pointed at the wrong URL, or a test event from the provider's dashboard. Returning 200
   * stops the provider retrying something that will never resolve, and the row is kept so
   * somebody can look.
   */
  private async findOrder(event: ProviderEvent) {
    if (!event.providerOrderId) return undefined;
    const order = await this.orders.findByProviderOrderId(event.providerOrderId);
    if (!order) {
      this.logger.warn(`webhook for unknown provider order ${event.providerOrderId}`);
      return undefined;
    }
    return order;
  }

  /** Upsert on the provider's payment id, which is what makes a redelivery idempotent. */
  private async recordPayment(
    event: ProviderEvent,
    orderId: string,
    status: 'CAPTURED' | 'FAILED',
  ): Promise<void> {
    if (!event.providerPaymentId) return;

    const timestamps =
      status === 'CAPTURED' ? { capturedAt: new Date() } : { failedAt: new Date() };

    const data = {
      status,
      amountMinor: event.amountMinor ?? 0,
      currency: (event.currency ?? 'INR') as never,
      method: event.method ?? null,
      failureCode: event.failureCode ?? null,
      ...timestamps,
    };

    await (this.prisma as PrismaClient).payment.upsert({
      where: { providerPaymentId: event.providerPaymentId },
      create: {
        orderId,
        provider: this.provider.name,
        providerPaymentId: event.providerPaymentId,
        ...data,
      },
      update: data,
    });
  }

  private async recordRefund(event: ProviderEvent, orderId: string): Promise<void> {
    if (!event.providerRefundId || !event.providerPaymentId) return;

    const payment = await this.prisma.payment.findUnique({
      where: { providerPaymentId: event.providerPaymentId },
      select: { id: true },
    });
    if (!payment) return;

    const data = {
      status: 'PROCESSED' as const,
      amountMinor: event.amountMinor ?? 0,
      processedAt: new Date(),
    };

    await this.prisma.refund.upsert({
      where: { providerRefundId: event.providerRefundId },
      create: { orderId, paymentId: payment.id, providerRefundId: event.providerRefundId, ...data },
      update: data,
    });
  }
}
