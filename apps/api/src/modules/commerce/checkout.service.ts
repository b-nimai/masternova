import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import { commerceConfig } from '../../config/configuration';
import {
  AlreadyOwnedException,
  CartEmptyException,
  CouponRejectedException,
} from '../../common/exceptions';
import { assertPurchasable } from './cart.service';
import { OrderService } from './order/order.service';
import { PricingService } from './pricing/pricing.service';
import { PAYMENT_PROVIDER, type IPaymentProvider } from './payment/payment-provider.interface';
import {
  CART_REPOSITORY,
  COUPON_REPOSITORY,
  ORDER_REPOSITORY,
  type ICartRepository,
  type ICouponRepository,
  type IOrderRepository,
  type OrderWithItems,
} from './repositories/commerce.repository.interface';

export interface CheckoutResult {
  readonly orderId: string;
  readonly status: OrderWithItems['status'];
  readonly totalMinor: number;
  readonly currency: string;
  /** Absent for a free order — there is nothing for the browser SDK to open. */
  readonly payment?: {
    readonly provider: string;
    readonly providerOrderId: string;
    readonly publicKey: string;
    readonly amountMinor: number;
  };
}

/**
 * One entry point over cart + pricing + order + provider (**Facade**).
 *
 * **The force.** Checking out is six things in a fixed order — read the cart, re-verify
 * every course is still buyable, re-price it, reserve the coupon, create the order, hand it
 * to the provider — and no caller should have to know that order, or which two of the six
 * must share a transaction. The controller says `checkout(userId, couponCode)`.
 *
 * It is a Facade and not a god service (CLAUDE.md §3): it holds no rules of its own.
 * Pricing belongs to `PricingService`, transitions to `OrderService`, provider translation
 * to the Adapter. What lives here is the *sequence*.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @Inject(CART_REPOSITORY) private readonly carts: ICartRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(COUPON_REPOSITORY) private readonly coupons: ICouponRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: IPaymentProvider,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(commerceConfig.KEY) private readonly config: ConfigType<typeof commerceConfig>,
    private readonly pricing: PricingService,
    private readonly ordering: OrderService,
  ) {}

  /**
   * Reached through `@Idempotent()`, so a client that retries a request it never saw the
   * answer to gets the first answer back rather than a second order.
   */
  async checkout(userId: string, couponCode?: string): Promise<CheckoutResult> {
    const cart = await this.carts.findOrCreate(userId);
    if (cart.items.length === 0) throw new CartEmptyException();

    const courses = cart.items.map((item) => item.course);

    // **Re-verified here, not trusted from the cart.** A course can be unpublished or
    // repriced while it sits in a cart for a week, and the cart's own check ran then.
    courses.forEach(assertPurchasable);

    const owned = await this.orders.ownedCourseIds(
      userId,
      courses.map((course) => course.id),
    );
    if (owned.length > 0) throw new AlreadyOwnedException(owned);

    const expiresAt = new Date(Date.now() + this.config.orderExpiryMinutes * 60_000);

    /**
     * Pricing, the coupon reservation and the order all commit together.
     *
     * The reservation is the reason. A coupon capped at 100 uses is checked by counting
     * `CouponRedemption` — so the count and the insert that makes it true must be in one
     * transaction, or two concurrent checkouts both read 99 and both redeem. Pricing runs
     * *inside* with the same executor precisely so it counts what the insert will race.
     */
    const order = await this.uow.execute(async (ctx) => {
      const quote = await this.pricing.quote({
        courses,
        userId,
        couponCode,
        executor: ctx.executor,
      });

      // A code that was fine when the cart was viewed and is not now — it ran out between
      // the two. The learner is told rather than silently charged full price.
      if (couponCode && quote.couponRejection) {
        throw new CouponRejectedException(quote.couponRejection, couponCode);
      }

      const created = await this.orders.create(
        {
          userId,
          currency: quote.currency,
          subtotalMinor: quote.subtotalMinor,
          discountMinor: quote.discountMinor,
          totalMinor: quote.totalMinor,
          couponId: quote.coupon?.id ?? null,
          expiresAt,
          items: quote.lines.map((line) => ({
            courseId: line.courseId,
            titleSnapshot: line.title,
            unitPriceMinor: line.unitPriceMinor,
            discountMinor: line.discountMinor,
          })),
        },
        ctx.executor,
      );

      if (quote.coupon) {
        // The insert IS the reservation. The count inside `quote` above saw the world this
        // insert joins, which is the whole reason both run on `ctx.executor`.
        await this.coupons.redeem(
          {
            couponId: quote.coupon.id,
            userId,
            orderId: created.id,
            discountMinor: quote.discountMinor,
          },
          ctx.executor,
        );
      }

      // The cart is emptied with the order that consumed it. Leaving it would let a second
      // tab check the same items out again while the first order is still awaiting payment.
      await this.carts.clear(cart.id, ctx.executor);

      return created;
    });

    // **A free order never reaches a provider.** Asking Razorpay to collect zero rupees
    // fails, and the platform has to be able to give a course away.
    if (order.totalMinor === 0) {
      const settled = await this.ordering.settleFree(order.id);
      return {
        orderId: order.id,
        status: settled.order.status,
        totalMinor: 0,
        currency: order.currency,
      };
    }

    const providerOrder = await this.provider.createOrder({
      orderId: order.id,
      amountMinor: order.totalMinor,
      currency: order.currency,
      notes: { userId },
    });

    await this.orders.setProviderOrderId(order.id, providerOrder.providerOrderId);
    await this.ordering.apply(order.id, 'submit');

    this.logger.log(
      `order ${order.id} submitted: ${order.totalMinor} ${order.currency} via ${this.provider.name}`,
    );

    return {
      orderId: order.id,
      status: 'AWAITING_PAYMENT',
      totalMinor: order.totalMinor,
      currency: order.currency,
      payment: {
        provider: this.provider.name,
        providerOrderId: providerOrder.providerOrderId,
        publicKey: providerOrder.publicKey,
        amountMinor: providerOrder.amountMinor,
      },
    };
  }
}
