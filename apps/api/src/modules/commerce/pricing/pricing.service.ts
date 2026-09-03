import { Inject, Injectable } from '@nestjs/common';
import type { Coupon, Currency } from '@masternova/db';
import { MixedCurrencyCartException } from '../../../common/exceptions';
import {
  COUPON_REPOSITORY,
  type ICouponRepository,
  type PurchasableCourse,
} from '../repositories/commerce.repository.interface';
import { allocateDiscount } from './money';
import {
  applyCoupon,
  CouponRejection,
  eligibleItems,
  type CouponRejectionReason,
} from './coupon-rules';

export interface PricedLine {
  readonly courseId: string;
  readonly title: string;
  readonly unitPriceMinor: number;
  readonly discountMinor: number;
}

export interface Quote {
  readonly currency: Currency;
  readonly lines: readonly PricedLine[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly coupon?: { readonly id: string; readonly code: string };
  /** Present when a code was supplied and refused. The quote is still valid without it. */
  readonly couponRejection?: CouponRejectionReason;
}

/**
 * What a set of courses costs, and nothing else.
 *
 * **Separate from `OrderService` on purpose** (CLAUDE.md §1 S). They change for different
 * reasons: pricing changes when the *business* changes — a new coupon kind, regional
 * pricing, a bundle discount — and order handling changes when the *payment flow* changes.
 * Fused, every promotion experiment risks the state machine that moves money, and every
 * class ends up needing the other's tests.
 *
 * It is also what lets the cart show a live total without creating an order: this is a pure
 * function of the courses, the coupon and the clock, and it is called on every cart read.
 */
@Injectable()
export class PricingService {
  constructor(@Inject(COUPON_REPOSITORY) private readonly coupons: ICouponRepository) {}

  /**
   * `executor` matters: at checkout this runs **inside the order's transaction**, so the
   * redemption counts it reads are the ones the insert will race against. Quoting a cart
   * outside a transaction is fine — nothing is being committed against that number.
   */
  async quote(input: {
    courses: readonly PurchasableCourse[];
    userId: string;
    couponCode?: string;
    now?: Date;
    executor?: unknown;
  }): Promise<Quote> {
    const currency = singleCurrency(input.courses);
    const lines = input.courses.map((course) => ({
      courseId: course.id,
      title: course.title,
      unitPriceMinor: course.priceMinor,
      discountMinor: 0,
    }));

    const subtotalMinor = lines.reduce((sum, line) => sum + line.unitPriceMinor, 0);

    if (!input.couponCode) {
      return { currency, lines, subtotalMinor, discountMinor: 0, totalMinor: subtotalMinor };
    }

    const applied = await this.applyCode({
      code: input.couponCode,
      userId: input.userId,
      currency,
      lines,
      now: input.now ?? new Date(),
      executor: input.executor,
    });

    if (!applied.ok) {
      // A bad code does not fail the quote. The learner still sees a price, plus a reason
      // the code did not work — refusing to price the cart at all would be a worse answer
      // to "I typed a coupon that expired".
      return {
        currency,
        lines,
        subtotalMinor,
        discountMinor: 0,
        totalMinor: subtotalMinor,
        couponRejection: applied.reason,
      };
    }

    // Spread across the lines it applied to, so the items sum exactly to the total and an
    // invoice reprints without a missing paise.
    const eligible = eligibleItems(applied.coupon, lines);
    const eligibleIds = new Set(eligible.map((line) => line.courseId));
    const shares = allocateDiscount(
      eligible.map((line) => line.unitPriceMinor),
      applied.discountMinor,
    );

    let shareIndex = 0;
    const priced = lines.map((line) =>
      eligibleIds.has(line.courseId) ? { ...line, discountMinor: shares[shareIndex++] } : line,
    );

    const discountMinor = priced.reduce((sum, line) => sum + line.discountMinor, 0);

    return {
      currency,
      lines: priced,
      subtotalMinor,
      discountMinor,
      totalMinor: subtotalMinor - discountMinor,
      coupon: { id: applied.coupon.id, code: applied.coupon.code },
    };
  }

  private async applyCode(input: {
    code: string;
    userId: string;
    currency: Currency;
    lines: readonly PricedLine[];
    now: Date;
    executor?: unknown;
  }): Promise<
    | { ok: true; coupon: Coupon; discountMinor: number }
    | { ok: false; reason: CouponRejectionReason }
  > {
    const coupon = await this.coupons.findByCode(input.code);
    if (!coupon) return { ok: false, reason: CouponRejection.NotFound };

    const eligible = eligibleItems(coupon, input.lines);
    const eligibleSubtotalMinor = eligible.reduce((sum, line) => sum + line.unitPriceMinor, 0);

    const counts = await this.coupons.countRedemptions(coupon.id, input.userId, input.executor);

    const check = applyCoupon({
      coupon,
      currency: input.currency,
      eligibleSubtotalMinor,
      now: input.now,
      globalRedemptions: counts.global,
      userRedemptions: counts.forUser,
    });

    return check.ok
      ? { ok: true, coupon, discountMinor: check.discountMinor }
      : { ok: false, reason: check.reason };
  }
}

/**
 * One currency per order.
 *
 * Refused rather than converted: there is no exchange rate this platform is willing to be
 * wrong about, and a cart that silently charges in the wrong currency is a chargeback.
 */
function singleCurrency(courses: readonly PurchasableCourse[]): Currency {
  const currencies = [...new Set(courses.map((course) => course.currency))];
  if (currencies.length > 1) throw new MixedCurrencyCartException(currencies);
  return currencies[0] ?? 'INR';
}
