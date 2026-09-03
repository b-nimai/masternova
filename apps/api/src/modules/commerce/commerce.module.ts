import { Module } from '@nestjs/common';
import { EntitlementModule } from '../entitlement/entitlement.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { AdminOrdersController, CheckoutController, OrdersController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { OrderExpiryService } from './order/order-expiry.service';
import { OrderService } from './order/order.service';
import { PaymentWebhookController } from './payment/payment-webhook.controller';
import { PAYMENT_PROVIDER } from './payment/payment-provider.interface';
import { RazorpayAdapter } from './payment/razorpay.adapter';
import { RefundService } from './payment/refund.service';
import { PaymentWebhookService } from './payment/webhook.service';
import { PricingService } from './pricing/pricing.service';
import {
  PrismaCartRepository,
  PrismaCouponRepository,
  PrismaOrderRepository,
} from './repositories/commerce.repository';
import {
  CART_REPOSITORY,
  COUPON_REPOSITORY,
  ORDER_REPOSITORY,
} from './repositories/commerce.repository.interface';

/**
 * Commerce.
 *
 * **`EntitlementModule` is imported for its `contracts` token, not its internals.** Commerce
 * grants access inside the order's transaction, and the only thing it can see of entitlement
 * is `ENTITLEMENT_GRANTING` — three methods, published in `packages/contracts`. The
 * `boundaries` lint rule fails the build on anything more (CLAUDE.md §4).
 *
 * **The provider is bound by a `Symbol`, never by class.** `CheckoutService` and
 * `RefundService` inject `PAYMENT_PROVIDER`; neither has heard of Razorpay. A second gateway
 * is a second adapter and one line here.
 */
@Module({
  imports: [EntitlementModule],
  controllers: [
    CartController,
    CheckoutController,
    OrdersController,
    AdminOrdersController,
    PaymentWebhookController,
  ],
  providers: [
    { provide: CART_REPOSITORY, useClass: PrismaCartRepository },
    { provide: COUPON_REPOSITORY, useClass: PrismaCouponRepository },
    { provide: ORDER_REPOSITORY, useClass: PrismaOrderRepository },
    { provide: PAYMENT_PROVIDER, useClass: RazorpayAdapter },

    PricingService,
    CartService,
    OrderService,
    CheckoutService,
    RefundService,
    PaymentWebhookService,
    OrderExpiryService,
  ],
  // For task 1.10's enrolment views, which need to know what a learner has bought.
  exports: [ORDER_REPOSITORY],
})
export class CommerceModule {}
