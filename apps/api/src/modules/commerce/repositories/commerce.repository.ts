import { Injectable } from '@nestjs/common';
import type { Coupon, OrderStatus, PrismaClient } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  CartWithItems,
  CreateOrderInput,
  ICartRepository,
  ICouponRepository,
  IOrderRepository,
  OrderWithItems,
} from './commerce.repository.interface';

/** The course fields pricing and purchasability read. Named once so the queries agree. */
const COURSE_FIELDS = {
  id: true,
  title: true,
  status: true,
  priceMinor: true,
  priceSetAt: true,
  currency: true,
  instructorId: true,
} as const;

/**
 * The transaction handle when the caller is inside a Unit of Work, else the base client.
 *
 * A free function rather than a shared abstract base class, and not only on the "prefer
 * composition" principle (CLAUDE.md §3): Nest reads constructor parameter types from the
 * **concrete** class, and a subclass inheriting its constructor from an undecorated base
 * gets no metadata — so `this.prisma` arrives `undefined` and every query fails at runtime
 * while typechecking perfectly. Found by the integration suite, which is the only place the
 * DI container is real.
 */
const clientFor = (prisma: PrismaService, executor?: unknown): PrismaClient =>
  (executor as PrismaClient) ?? prisma;

@Injectable()
export class PrismaCartRepository implements ICartRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreate(userId: string): Promise<CartWithItems> {
    // Upsert rather than find-then-create: two tabs adding at once both see no cart, and
    // the unique constraint on userId has to arbitrate rather than 500.
    return this.prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
      include: { items: { include: { course: { select: COURSE_FIELDS } } } },
    });
  }

  async addItem(cartId: string, courseId: string): Promise<void> {
    // Adding twice is not an error — the learner clicked twice. The unique pair makes the
    // second one a no-op instead of a duplicate line.
    await this.prisma.cartItem.upsert({
      where: { cartId_courseId: { cartId, courseId } },
      create: { cartId, courseId },
      update: {},
    });
  }

  async removeItem(cartId: string, courseId: string): Promise<void> {
    // deleteMany, so removing something already gone is a no-op rather than P2025.
    await this.prisma.cartItem.deleteMany({ where: { cartId, courseId } });
  }

  async clear(cartId: string, executor?: unknown): Promise<void> {
    await clientFor(this.prisma, executor).cartItem.deleteMany({ where: { cartId } });
  }
}

@Injectable()
export class PrismaCouponRepository implements ICouponRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByCode(code: string): Promise<Coupon | null> {
    // Nobody types a promo code with the capitalisation the marketing email used.
    return this.prisma.coupon.findFirst({
      where: { code: { equals: code.trim(), mode: 'insensitive' } },
    });
  }

  /**
   * Both counts in one round trip, from `CouponRedemption` rather than the denormalised
   * counter on `Coupon`. The counter is for display: reading it and then incrementing is a
   * check-then-act, and a coupon capped at 100 goes to 140 the day it is posted publicly.
   */
  async countRedemptions(
    couponId: string,
    userId: string,
    executor?: unknown,
  ): Promise<{ global: number; forUser: number }> {
    const client = clientFor(this.prisma, executor);
    const [global, forUser] = await Promise.all([
      client.couponRedemption.count({ where: { couponId } }),
      client.couponRedemption.count({ where: { couponId, userId } }),
    ]);
    return { global, forUser };
  }

  async redeem(
    input: { couponId: string; userId: string; orderId: string; discountMinor: number },
    executor?: unknown,
  ): Promise<void> {
    const client = clientFor(this.prisma, executor);
    await client.couponRedemption.create({ data: input });
    // Display only, and deliberately updated separately from the row above: this counter is
    // never what the limit is enforced against, so a drift here is cosmetic rather than a
    // coupon that over-redeems.
    await client.coupon.update({
      where: { id: input.couponId },
      data: { redemptionCount: { increment: 1 } },
    });
  }

  async release(orderId: string, executor?: unknown): Promise<void> {
    const client = clientFor(this.prisma, executor);
    const redemptions = await client.couponRedemption.findMany({
      where: { orderId },
      select: { couponId: true },
    });
    if (redemptions.length === 0) return;

    await client.couponRedemption.deleteMany({ where: { orderId } });
    for (const { couponId } of redemptions) {
      // Floored at zero: a counter that has drifted must not go negative and make the
      // dashboard read "-1 of 100 used".
      const coupon = await client.coupon.findUnique({
        where: { id: couponId },
        select: { redemptionCount: true },
      });
      await client.coupon.update({
        where: { id: couponId },
        data: { redemptionCount: Math.max(0, (coupon?.redemptionCount ?? 1) - 1) },
      });
    }
  }
}

@Injectable()
export class PrismaOrderRepository implements IOrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateOrderInput, executor?: unknown): Promise<OrderWithItems> {
    return clientFor(this.prisma, executor).order.create({
      data: {
        userId: input.userId,
        currency: input.currency,
        subtotalMinor: input.subtotalMinor,
        discountMinor: input.discountMinor,
        totalMinor: input.totalMinor,
        couponId: input.couponId ?? null,
        expiresAt: input.expiresAt,
        items: { create: input.items.map((item) => ({ ...item })) },
      },
      include: { items: true },
    });
  }

  findById(orderId: string, executor?: unknown): Promise<OrderWithItems | null> {
    return clientFor(this.prisma, executor).order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
  }

  findByProviderOrderId(
    providerOrderId: string,
    executor?: unknown,
  ): Promise<OrderWithItems | null> {
    return clientFor(this.prisma, executor).order.findUnique({
      where: { providerOrderId },
      include: { items: true },
    });
  }

  listForUser(userId: string, limit: number): Promise<OrderWithItems[]> {
    return this.prisma.order.findMany({
      where: { userId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * `updateMany` with the source status in the WHERE clause, so the database decides.
   *
   * The two callers racing here are a provider webhook and the learner's browser redirect,
   * arriving milliseconds apart for the same payment. Reading the status and then writing
   * would let both see AWAITING_PAYMENT and both proceed — one entitlement grant and one
   * receipt each. With the condition in the statement, exactly one update matches a row,
   * and `false` tells the loser to do nothing.
   */
  async transition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    patch: Record<string, unknown>,
    executor?: unknown,
  ): Promise<boolean> {
    const result = await clientFor(this.prisma, executor).order.updateMany({
      where: { id: orderId, status: from },
      data: { status: to, ...patch },
    });
    return result.count === 1;
  }

  async setProviderOrderId(
    orderId: string,
    providerOrderId: string,
    executor?: unknown,
  ): Promise<void> {
    await clientFor(this.prisma, executor).order.update({
      where: { id: orderId },
      data: { providerOrderId },
    });
  }

  findExpirable(now: Date, limit: number): Promise<OrderWithItems[]> {
    return this.prisma.order.findMany({
      where: { status: { in: ['CREATED', 'AWAITING_PAYMENT'] }, expiresAt: { lte: now } },
      include: { items: true },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Read from `OrderItem` joined to a PAID order, not from `Entitlement`.
   *
   * They agree today, but they answer different questions: an entitlement can exist without
   * a purchase (a free enrolment, an admin grant) and buying a course you were *given* is a
   * legitimate thing to want to do. What must be refused is paying twice for the same thing.
   */
  async ownedCourseIds(userId: string, courseIds: readonly string[]): Promise<string[]> {
    if (courseIds.length === 0) return [];

    const rows = await this.prisma.orderItem.findMany({
      where: { courseId: { in: [...courseIds] }, order: { userId, status: 'PAID' } },
      select: { courseId: true },
      distinct: ['courseId'],
    });
    return rows.map((row) => row.courseId);
  }
}
