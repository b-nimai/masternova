import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CommerceEvent,
  ENTITLEMENT_GRANTING,
  UNIT_OF_WORK,
  type EntitlementGranting,
  type EntitlementKeyRef,
  type TransactionContext,
  type UnitOfWork,
} from '@masternova/contracts';
import {
  IllegalOrderTransitionException,
  OrderNotFoundException,
} from '../../../common/exceptions';
import {
  COUPON_REPOSITORY,
  ORDER_REPOSITORY,
  type ICouponRepository,
  type IOrderRepository,
  type OrderWithItems,
} from '../repositories/commerce.repository.interface';
import { transitionFor } from './order-state-machine';
import { orderExpiredPayload } from './order-expired.payload';

/** What a caller learns without having to re-read the order. */
export interface TransitionOutcome {
  readonly applied: boolean;
  readonly order: OrderWithItems;
}

/**
 * Moves orders, and owns everything that must happen atomically with the move.
 *
 * **Deliberately not the pricing.** `PricingService` decides what things cost; this decides
 * what state an order is in and what that state change causes (CLAUDE.md §1 S). The two
 * change for different reasons — a new coupon kind must not risk the code that moves money.
 *
 * **Every transition is a conditional UPDATE**, never a read-then-write. The two callers
 * racing on the capture path are a provider webhook and the learner's browser redirect,
 * arriving milliseconds apart for the same payment. `WHERE status = ?` makes the database
 * pick one winner; the loser gets `applied: false` and does nothing.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(COUPON_REPOSITORY) private readonly coupons: ICouponRepository,
    @Inject(ENTITLEMENT_GRANTING) private readonly entitlements: EntitlementGranting,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  /**
   * The one that matters: money captured → access granted → event raised, **in one
   * transaction**.
   *
   * The entitlement is written here rather than by an `order.paid` consumer because it
   * cannot fail independently of the order: an order that is PAID with no entitlement is a
   * learner who paid and cannot watch, and the window would be however long the outbox relay
   * takes to poll. The effects that *can* fail independently — the invoice, the receipt
   * email — go through the outbox, which is what the event is for. See ADR-0020.
   *
   * Returns `applied: false` when the order had already moved. That is the expected answer
   * on a redelivered webhook, not an error.
   */
  async capture(
    orderId: string,
    input: { paidAt: Date; source?: 'service' | 'webhook' },
    work?: (ctx: TransactionContext, order: OrderWithItems) => Promise<void>,
  ): Promise<TransitionOutcome> {
    return this.settle(orderId, 'capture', input.source ?? 'webhook', input.paidAt, work);
  }

  /** A cart discounted to nothing. Never reaches a provider, so nothing can capture it. */
  async settleFree(orderId: string): Promise<TransitionOutcome> {
    return this.settle(orderId, 'settleFree', 'service', new Date());
  }

  private async settle(
    orderId: string,
    name: 'capture' | 'settleFree',
    source: 'service' | 'webhook',
    paidAt: Date,
    work?: (ctx: TransactionContext, order: OrderWithItems) => Promise<void>,
  ): Promise<TransitionOutcome> {
    const order = await this.require(orderId);
    const edge = transitionFor(order.status, name, source);

    if (!edge) {
      // No such edge. On the webhook path this is routine — a provider redelivering a
      // capture for an order that is already PAID — so it is reported, not thrown.
      this.logger.log(`order ${orderId} cannot ${name} from ${order.status}; ignoring`);
      return { applied: false, order };
    }

    const granted: EntitlementKeyRef[] = [];

    const result = await this.uow.execute(async (ctx) => {
      const applied = await this.orders.transition(
        orderId,
        order.status,
        edge.to,
        { paidAt, statusReason: null },
        ctx.executor,
      );

      // Somebody else won the race between the read above and this UPDATE. Everything below
      // is theirs to do, and doing it again would grant twice and email twice.
      if (!applied) return false;

      for (const item of order.items) {
        await this.entitlements.grant(
          {
            userId: order.userId,
            courseId: item.courseId,
            source: order.totalMinor === 0 ? 'FREE_ENROLLMENT' : 'PURCHASE',
            orderId: order.id,
          },
          ctx.executor,
        );
        granted.push({ userId: order.userId, courseId: item.courseId });
      }

      ctx.publish({
        type: CommerceEvent.OrderPaid,
        aggregateType: 'Order',
        aggregateId: order.id,
        payload: {
          orderId: order.id,
          userId: order.userId,
          currency: order.currency,
          subtotalMinor: order.subtotalMinor,
          discountMinor: order.discountMinor,
          totalMinor: order.totalMinor,
          items: order.items.map((item) => ({
            courseId: item.courseId,
            title: item.titleSnapshot,
            unitPriceMinor: item.unitPriceMinor,
            discountMinor: item.discountMinor,
          })),
          paidAt: paidAt.toISOString(),
        },
      });

      await work?.(ctx, order);
      return true;
    });

    // **After the commit, never inside it.** A cache dropped mid-transaction is refilled
    // with the pre-grant row by any concurrent read, and the learner who just paid is told
    // they have no access for the cache's whole TTL.
    if (result) await this.entitlements.forget(granted);

    return { applied: result, order: (await this.orders.findById(orderId)) ?? order };
  }

  /**
   * Refund: money back, access revoked, event raised — again in one transaction, and for
   * the mirror-image reason. An order marked REFUNDED whose entitlement survived is a
   * learner watching content they were paid back for.
   */
  async refund(
    orderId: string,
    input: { reason?: string; source?: 'service' | 'webhook' },
    work?: (ctx: TransactionContext, order: OrderWithItems) => Promise<void>,
  ): Promise<TransitionOutcome> {
    const order = await this.require(orderId);
    const edge = transitionFor(order.status, 'refund', input.source ?? 'webhook');

    if (!edge) {
      this.logger.log(`order ${orderId} cannot refund from ${order.status}; ignoring`);
      return { applied: false, order };
    }

    let revoked: readonly EntitlementKeyRef[] = [];
    const refundedAt = new Date();

    const result = await this.uow.execute(async (ctx) => {
      const applied = await this.orders.transition(
        orderId,
        order.status,
        'REFUNDED',
        { refundedAt, statusReason: input.reason ?? null },
        ctx.executor,
      );
      if (!applied) return false;

      revoked = await this.entitlements.revokeByOrder(
        order.id,
        input.reason ?? 'refund',
        ctx.executor,
      );

      ctx.publish({
        type: CommerceEvent.OrderRefunded,
        aggregateType: 'Order',
        aggregateId: order.id,
        payload: {
          orderId: order.id,
          userId: order.userId,
          currency: order.currency,
          amountMinor: order.totalMinor,
          reason: input.reason,
          courseIds: order.items.map((item) => item.courseId),
          refundedAt: refundedAt.toISOString(),
        },
      });

      await work?.(ctx, order);
      return true;
    });

    if (result) await this.entitlements.forget(revoked);

    return { applied: result, order: (await this.orders.findById(orderId)) ?? order };
  }

  /**
   * The transitions that grant nothing: `submit`, `cancel`, `fail`, `expire`.
   *
   * **They still have one side effect, and forgetting it is expensive: the coupon.** An
   * order holds a `CouponRedemption` from the moment it is created, and that row is what
   * enforces `maxRedemptions` and `perUserLimit`. Every way an order can die without being
   * paid — the learner cancels, the card is declined, nobody pays in time — must give the
   * redemption back, or a `perUserLimit: 1` code is spent by clicking cancel and a 100-use
   * launch coupon is burnt down by declined cards. Only `submit` keeps it, because a
   * submitted order is still going to be paid.
   *
   * The release and the status change commit together: an order marked CANCELLED whose
   * redemption survived holds the coupon forever, with nothing left to sweep it.
   */
  async apply(
    orderId: string,
    name: 'submit' | 'cancel' | 'fail' | 'expire',
    input: { reason?: string; source?: 'service' | 'webhook' } = {},
  ): Promise<TransitionOutcome> {
    const order = await this.require(orderId);
    const edge = transitionFor(order.status, name, input.source ?? 'service');

    if (!edge) {
      // Unlike capture, these are driven by a user action or our own sweeper, where an
      // impossible transition is a real conflict the caller has to see.
      if ((input.source ?? 'service') === 'service') {
        throw new IllegalOrderTransitionException(order.status, name);
      }
      return { applied: false, order };
    }

    const patch: Record<string, unknown> = { statusReason: input.reason ?? null };
    if (edge.to === 'CANCELLED') patch.cancelledAt = new Date();

    const applied = await this.uow.execute(async (ctx) => {
      const moved = await this.orders.transition(
        order.id,
        order.status,
        edge.to,
        patch,
        ctx.executor,
      );
      if (!moved) return false;

      // `release` is a no-op when the order carried no coupon, so this needs no branch on
      // whether one was applied.
      if (edge.to !== 'AWAITING_PAYMENT') {
        await this.coupons.release(order.id, ctx.executor);
      }

      if (edge.event) {
        ctx.publish({
          type: edge.event,
          aggregateType: 'Order',
          aggregateId: order.id,
          // `expire` is the only event-carrying edge that reaches here — cancel, fail and
          // submit deliberately emit nothing — so the payload is built by the same function
          // the sweeper uses. See `order-expired.payload.ts` for why that matters.
          payload: orderExpiredPayload(order),
        });
      }
      return true;
    });

    return { applied, order: (await this.orders.findById(orderId)) ?? order };
  }

  private async require(orderId: string): Promise<OrderWithItems> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new OrderNotFoundException();
    return order;
  }
}
