import { Inject, Injectable } from '@nestjs/common';
import { AlreadyOwnedException, CourseNotPurchasableException } from '../../common/exceptions';
import { PricingService, type Quote } from './pricing/pricing.service';
import {
  CART_REPOSITORY,
  ORDER_REPOSITORY,
  type ICartRepository,
  type IOrderRepository,
  type PurchasableCourse,
} from './repositories/commerce.repository.interface';

export interface CartView extends Quote {
  readonly cartId: string;
  /** Already bought. Shown rather than hidden, so "why is this cheaper?" has an answer. */
  readonly ownedCourseIds: readonly string[];
}

/**
 * The cart, and what it currently costs.
 *
 * **Priced on every read, never stored.** A cart is a list of intentions, not a quote: a
 * course discounted after it went into the cart shows the new price, and there is no stale
 * number to explain away at checkout. That is why `CartItem` has no price column.
 */
@Injectable()
export class CartService {
  constructor(
    @Inject(CART_REPOSITORY) private readonly carts: ICartRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    private readonly pricing: PricingService,
  ) {}

  async view(userId: string, couponCode?: string): Promise<CartView> {
    const cart = await this.carts.findOrCreate(userId);
    const courses = cart.items.map((item) => item.course);

    const quote = await this.pricing.quote({ courses, userId, couponCode });
    const ownedCourseIds = await this.orders.ownedCourseIds(
      userId,
      courses.map((course) => course.id),
    );

    return { ...quote, cartId: cart.id, ownedCourseIds };
  }

  /**
   * Adding is checked, because a cart full of things that cannot be bought is a checkout
   * that fails at the last step — the worst possible place to discover it.
   */
  async add(userId: string, course: PurchasableCourse): Promise<CartView> {
    assertPurchasable(course);

    const owned = await this.orders.ownedCourseIds(userId, [course.id]);
    if (owned.length > 0) throw new AlreadyOwnedException(owned);

    const cart = await this.carts.findOrCreate(userId);
    await this.carts.addItem(cart.id, course.id);
    return this.view(userId);
  }

  async remove(userId: string, courseId: string): Promise<CartView> {
    const cart = await this.carts.findOrCreate(userId);
    await this.carts.removeItem(cart.id, courseId);
    return this.view(userId);
  }
}

/**
 * The three reasons a course cannot be bought.
 *
 * Shared by the cart and by checkout, and **checked again at checkout** — a course can be
 * unpublished or repriced while it sits in somebody's cart for a week.
 */
export function assertPurchasable(course: PurchasableCourse): void {
  if (course.status !== 'PUBLISHED') {
    throw new CourseNotPurchasableException(course.id, 'COURSE_NOT_PUBLISHED');
  }
  // The same ambiguity the entitlement engine handles: zero is both "free" and "nobody has
  // priced it yet", and selling the second one is selling something at a price its author
  // never agreed to.
  if (course.priceSetAt === null) {
    throw new CourseNotPurchasableException(course.id, 'COURSE_NOT_PRICED');
  }
}
