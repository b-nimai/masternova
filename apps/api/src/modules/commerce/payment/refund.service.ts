import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  IllegalOrderTransitionException,
  OrderNotFoundException,
  PaymentProviderException,
} from '../../../common/exceptions';
import { OrderService, type TransitionOutcome } from '../order/order.service';
import {
  ORDER_REPOSITORY,
  type IOrderRepository,
} from '../repositories/commerce.repository.interface';
import { PAYMENT_PROVIDER, type IPaymentProvider } from './payment-provider.interface';

/**
 * Refunds money, then revokes access.
 *
 * **The order of the two is the decision.** Revoking first and then discovering the provider
 * refuses the refund leaves a learner who paid, kept their money, and lost their course —
 * the worst of the four outcomes. Refunding first risks the mirror case (money returned,
 * access briefly retained), which is recoverable and costs the platform a course rather than
 * costing a customer their money.
 *
 * It is separate from `OrderService` because it is the only place in commerce that makes an
 * **outbound** call to the provider on a request path. `OrderService.refund` is a state
 * transition and is also reached by the webhook, where the money has already moved and
 * calling the provider again would be a second refund.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: IPaymentProvider,
    private readonly ordering: OrderService,
  ) {}

  async refund(orderId: string, reason: string): Promise<TransitionOutcome> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new OrderNotFoundException();

    if (order.status !== 'PAID') {
      throw new IllegalOrderTransitionException(order.status, 'refund');
    }

    // A free order has no payment to reverse. Revoking access is still the right effect, so
    // it goes straight to the state change rather than being refused.
    if (order.totalMinor === 0) {
      return this.ordering.refund(orderId, { reason, source: 'service' });
    }

    const payment = await this.prisma.payment.findFirst({
      where: { orderId, status: 'CAPTURED' },
      orderBy: { capturedAt: 'desc' },
    });

    if (!payment) {
      // PAID with no captured payment row means the two disagree, and guessing which is
      // right is not this service's call. Refusing is the only safe answer.
      throw new PaymentProviderException(
        `order ${orderId} is PAID but has no captured payment to refund`,
      );
    }

    /**
     * `orderId` as the idempotency key, not a random one.
     *
     * It is stable across our own retries, so a refund we asked for twice — because the
     * first response timed out after the provider had already acted — is one refund at their
     * end, not two. A random key would make the retry a second withdrawal.
     */
    const refunded = await this.provider.refund({
      providerPaymentId: payment.providerPaymentId,
      amountMinor: payment.amountMinor,
      reason,
      idempotencyKey: `refund:${orderId}`,
    });

    await this.prisma.refund.upsert({
      where: { providerRefundId: refunded.providerRefundId },
      create: {
        orderId,
        paymentId: payment.id,
        providerRefundId: refunded.providerRefundId,
        status: refunded.status,
        amountMinor: refunded.amountMinor,
        reason,
        processedAt: refunded.status === 'PROCESSED' ? new Date() : null,
      },
      update: { status: refunded.status },
    });

    this.logger.log(
      `refunded ${refunded.amountMinor} for order ${orderId} (${refunded.providerRefundId}, ${refunded.status})`,
    );

    /**
     * The state change happens now, not when `refund.processed` arrives.
     *
     * A refund the provider has accepted will settle; making the learner keep access until
     * the webhook lands means hours of watching content that has been paid back. The webhook
     * still arrives and still runs, and finds an order already REFUNDED — which the state
     * machine answers with "no such edge", i.e. a no-op. That is the same mechanism that
     * makes every redelivered capture safe.
     */
    return this.ordering.refund(orderId, { reason, source: 'service' });
  }
}
