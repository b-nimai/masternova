import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  checkoutSchema,
  refundOrderSchema,
  type CheckoutInput,
  type OrderView,
  type RefundOrderInput,
} from '@masternova/shared';
import { ZodBody } from '../../common/pipes/zod-body.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { OrderNotFoundException } from '../../common/exceptions';
import { CheckoutService, type CheckoutResult } from './checkout.service';
import { OrderService } from './order/order.service';
import { RefundService } from './payment/refund.service';
import { toOrderView } from './order.mapper';
import {
  ORDER_REPOSITORY,
  type IOrderRepository,
} from './repositories/commerce.repository.interface';
import { Inject } from '@nestjs/common';

@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /**
   * **`@Idempotent()` is not decoration here.** A learner whose connection drops mid-request
   * will retry, and without the stored response that retry creates a second order and a
   * second charge. This is the endpoint the whole mechanism was built for.
   */
  @Post()
  @Idempotent()
  create(
    @Req() request: FastifyRequest,
    @ZodBody(checkoutSchema) body: CheckoutInput,
  ): Promise<CheckoutResult> {
    return this.checkout.checkout(request.userId as string, body.couponCode);
  }
}

@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    private readonly ordering: OrderService,
  ) {}

  @Get()
  async list(@Req() request: FastifyRequest, @Query('limit') limit?: string): Promise<OrderView[]> {
    const orders = await this.orders.listForUser(
      request.userId as string,
      Math.min(Number(limit) || 20, 100),
    );
    return orders.map(toOrderView);
  }

  @Get(':id')
  async get(@Req() request: FastifyRequest, @Param('id') id: string): Promise<OrderView> {
    const order = await this.orders.findById(id);
    // Somebody else's order is a 404, not a 403 — the same rule the rest of the API follows
    // so an endpoint is not an oracle for guessing ids.
    if (!order || order.userId !== request.userId) throw new OrderNotFoundException();
    return toOrderView(order);
  }

  @Post(':id/cancel')
  async cancel(@Req() request: FastifyRequest, @Param('id') id: string): Promise<OrderView> {
    const order = await this.orders.findById(id);
    if (!order || order.userId !== request.userId) throw new OrderNotFoundException();

    const outcome = await this.ordering.apply(id, 'cancel');
    return toOrderView(outcome.order);
  }
}

/**
 * Refunds are **admin only**, and initiated here rather than by a learner.
 *
 * A self-serve refund button is a product decision nobody has made, and this endpoint moves
 * money and revokes access — the two things most worth requiring a human for.
 */
@Roles('ADMIN')
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly refunds: RefundService) {}

  /**
   * Goes through `RefundService`, not straight to the state machine: this must move money
   * at the provider before it revokes access, and `OrderService.refund` is only the state
   * change — the half the webhook path also uses, where the money has already moved.
   */
  @Post(':id/refund')
  @HttpCode(202)
  async refund(
    @Param('id') id: string,
    @ZodBody(refundOrderSchema) body: RefundOrderInput,
  ): Promise<OrderView> {
    const outcome = await this.refunds.refund(id, body.reason ?? 'admin refund');
    return toOrderView(outcome.order);
  }
}
