import type { Coupon, Currency } from '@masternova/db';
import { clampDiscount, percentOff } from './money';

/**
 * Why a coupon cannot be used. Stable codes, for the same reason entitlement's are: the
 * checkout page shows a different message for each, and parsing English is not a plan.
 */
export const CouponRejection = {
  NotFound: 'COUPON_NOT_FOUND',
  Inactive: 'COUPON_INACTIVE',
  NotStarted: 'COUPON_NOT_STARTED',
  Expired: 'COUPON_EXPIRED',
  CurrencyMismatch: 'COUPON_CURRENCY_MISMATCH',
  NotApplicable: 'COUPON_NOT_APPLICABLE_TO_ITEMS',
  GlobalLimitReached: 'COUPON_FULLY_REDEEMED',
  UserLimitReached: 'COUPON_ALREADY_USED',
} as const;

export type CouponRejectionReason = (typeof CouponRejection)[keyof typeof CouponRejection];

export interface CouponContext {
  readonly coupon: Coupon;
  readonly currency: Currency;
  /** Only the items the coupon could apply to matter for the amount. */
  readonly eligibleSubtotalMinor: number;
  readonly now: Date;
  /** Counted from `CouponRedemption`, inside the order's transaction. */
  readonly globalRedemptions: number;
  readonly userRedemptions: number;
}

export type CouponCheck =
  | { readonly ok: true; readonly discountMinor: number }
  | { readonly ok: false; readonly reason: CouponRejectionReason };

/**
 * Every reason a coupon can be refused, as an ordered list of **Specifications**.
 *
 * Each is a pure predicate over the context, so the whole set is testable with no database
 * and no clock — and adding "minimum order value" or "first purchase only" is a new entry
 * here, not an edit to a validation method that already works.
 *
 * Unlike the entitlement chain this **does** stop at the first failure, and the difference
 * is worth being able to explain: there, several rules can have opinions and a denial must
 * beat an allowance regardless of order. Here the rules are independent gates on one
 * decision, every one of them must pass, and the learner is shown a single reason — so the
 * first failure is the answer, and evaluating the rest would only cost work to discard.
 */
const RULES: readonly {
  readonly reason: CouponRejectionReason;
  readonly rejects: (ctx: CouponContext) => boolean;
}[] = [
  {
    reason: CouponRejection.Inactive,
    rejects: (ctx) => !ctx.coupon.active,
  },
  {
    reason: CouponRejection.NotStarted,
    rejects: (ctx) => ctx.coupon.startsAt !== null && ctx.coupon.startsAt > ctx.now,
  },
  {
    reason: CouponRejection.Expired,
    rejects: (ctx) => ctx.coupon.endsAt !== null && ctx.coupon.endsAt <= ctx.now,
  },
  {
    // A ₹500-off coupon on a $ order is not a conversion problem to solve, it is a coupon
    // that does not apply. PERCENT coupons carry no currency and work anywhere.
    //
    // **A FIXED coupon with a null currency is rejected too, not waved through.** `value`
    // on a FIXED coupon is an amount in minor units, and an amount without a currency is
    // not a number this rule can compare — `50000` meant as ₹500 would otherwise take $500
    // off a USD cart. The schema allows the shape (`currency Currency?` serves PERCENT), so
    // the guard belongs here rather than in the column.
    reason: CouponRejection.CurrencyMismatch,
    rejects: (ctx) => ctx.coupon.kind === 'FIXED' && ctx.coupon.currency !== ctx.currency,
  },
  {
    // An empty `courseIds` means every course; a non-empty one that matched nothing in this
    // cart means the learner typed a code for something they are not buying.
    reason: CouponRejection.NotApplicable,
    rejects: (ctx) => ctx.eligibleSubtotalMinor <= 0,
  },
  {
    reason: CouponRejection.GlobalLimitReached,
    rejects: (ctx) =>
      ctx.coupon.maxRedemptions !== null && ctx.globalRedemptions >= ctx.coupon.maxRedemptions,
  },
  {
    reason: CouponRejection.UserLimitReached,
    rejects: (ctx) => ctx.userRedemptions >= ctx.coupon.perUserLimit,
  },
];

/**
 * Apply a coupon, or say precisely why not.
 *
 * The amount is computed only after every gate has passed, so there is no path that returns
 * a discount from a coupon that should have been refused.
 */
export function applyCoupon(ctx: CouponContext): CouponCheck {
  for (const rule of RULES) {
    if (rule.rejects(ctx)) return { ok: false, reason: rule.reason };
  }

  const raw =
    ctx.coupon.kind === 'PERCENT'
      ? percentOff(ctx.eligibleSubtotalMinor, ctx.coupon.value)
      : ctx.coupon.value;

  // Capped at the eligible subtotal, not the order's: a ₹500-off coupon restricted to one
  // ₹200 course takes ₹200 off, not ₹500 off the whole basket.
  return { ok: true, discountMinor: clampDiscount(raw, ctx.eligibleSubtotalMinor) };
}

/** Which of the order's items this coupon is allowed to touch. */
export function eligibleItems<T extends { courseId: string }>(
  coupon: Pick<Coupon, 'courseIds'>,
  items: readonly T[],
): readonly T[] {
  if (coupon.courseIds.length === 0) return items;
  const allowed = new Set(coupon.courseIds);
  return items.filter((item) => allowed.has(item.courseId));
}
