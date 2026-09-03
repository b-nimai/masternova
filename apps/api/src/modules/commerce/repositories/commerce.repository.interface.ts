import type { Cart, CartItem, Coupon, Course, Order, OrderItem, OrderStatus } from '@masternova/db';

export const CART_REPOSITORY = Symbol('CART_REPOSITORY');
export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
export const COUPON_REPOSITORY = Symbol('COUPON_REPOSITORY');

/** Exactly what pricing and the purchasability checks read. Not the whole course. */
export type PurchasableCourse = Pick<
  Course,
  'id' | 'title' | 'status' | 'priceMinor' | 'priceSetAt' | 'currency' | 'instructorId'
>;

export type CartWithItems = Cart & { items: (CartItem & { course: PurchasableCourse })[] };
export type OrderWithItems = Order & { items: OrderItem[] };

export interface ICartRepository {
  /**
   * **An upsert, not a find-then-create.** Two tabs adding a course at the same moment both
   * see no cart and both insert; the unique constraint on `userId` makes one of them lose,
   * and losing has to mean "use the winner's cart", not "500".
   */
  findOrCreate(userId: string): Promise<CartWithItems>;
  addItem(cartId: string, courseId: string): Promise<void>;
  removeItem(cartId: string, courseId: string): Promise<void>;
  clear(cartId: string, executor?: unknown): Promise<void>;
}

export interface ICouponRepository {
  /** Case-insensitive: nobody types a promo code with the capitalisation the email used. */
  findByCode(code: string): Promise<Coupon | null>;
  /** Counted inside the order's transaction, which is what makes the cap hold under load. */
  countRedemptions(
    couponId: string,
    userId: string,
    executor?: unknown,
  ): Promise<{ global: number; forUser: number }>;

  /**
   * **The insert IS the reservation**, and it must run in the same transaction as the count
   * above. `@@unique([couponId, orderId])` makes applying a coupon twice to one order
   * impossible; the transaction is what stops two concurrent checkouts both reading 99 of
   * 100 and both redeeming.
   */
  redeem(
    input: { couponId: string; userId: string; orderId: string; discountMinor: number },
    executor?: unknown,
  ): Promise<void>;

  /** Give the redemption back when an order expires or is refunded. */
  release(orderId: string, executor?: unknown): Promise<void>;
}

export interface CreateOrderInput {
  readonly userId: string;
  readonly currency: OrderWithItems['currency'];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly couponId?: string | null;
  readonly expiresAt: Date;
  readonly items: readonly {
    courseId: string;
    titleSnapshot: string;
    unitPriceMinor: number;
    discountMinor: number;
  }[];
}

export interface IOrderRepository {
  create(input: CreateOrderInput, executor?: unknown): Promise<OrderWithItems>;
  findById(orderId: string, executor?: unknown): Promise<OrderWithItems | null>;
  findByProviderOrderId(
    providerOrderId: string,
    executor?: unknown,
  ): Promise<OrderWithItems | null>;
  listForUser(userId: string, limit: number): Promise<OrderWithItems[]>;

  /**
   * **A conditional update, and this is the concurrency control.**
   *
   * Returns whether it changed a row. Read-status-then-write would be a check-then-act, and
   * the two callers racing here are a webhook and a browser redirect arriving milliseconds
   * apart for the same payment — so the `WHERE status = ?` is what makes exactly one of them
   * the winner, and the loser's `false` is the signal to do nothing rather than to retry.
   */
  transition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    patch: Record<string, unknown>,
    executor?: unknown,
  ): Promise<boolean>;

  setProviderOrderId(orderId: string, providerOrderId: string, executor?: unknown): Promise<void>;

  /** Unpaid orders past their window. The sweeper's only query. */
  findExpirable(now: Date, limit: number): Promise<OrderWithItems[]>;

  /** Which of these courses the user already has a paid order for. */
  ownedCourseIds(userId: string, courseIds: readonly string[]): Promise<string[]>;
}
