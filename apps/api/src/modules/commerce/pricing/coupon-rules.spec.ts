import type { Coupon } from '@masternova/db';
import { applyCoupon, CouponRejection, eligibleItems, type CouponContext } from './coupon-rules';

const NOW = new Date('2026-09-03T12:00:00.000Z');

const coupon = (over: Partial<Coupon> = {}): Coupon =>
  ({
    id: 'c1',
    code: 'LAUNCH50',
    kind: 'PERCENT',
    value: 5000,
    currency: null,
    courseIds: [],
    maxRedemptions: null,
    perUserLimit: 1,
    startsAt: null,
    endsAt: null,
    active: true,
    redemptionCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as Coupon;

const context = (over: Partial<CouponContext> = {}): CouponContext => ({
  coupon: coupon(),
  currency: 'INR',
  eligibleSubtotalMinor: 100_00,
  now: NOW,
  globalRedemptions: 0,
  userRedemptions: 0,
  ...over,
});

describe('applyCoupon', () => {
  it('takes a percentage in basis points', () => {
    expect(applyCoupon(context())).toEqual({ ok: true, discountMinor: 50_00 });
  });

  it('takes a fixed amount', () => {
    const ctx = context({ coupon: coupon({ kind: 'FIXED', value: 20_00, currency: 'INR' }) });
    expect(applyCoupon(ctx)).toEqual({ ok: true, discountMinor: 20_00 });
  });

  /** A ₹500-off coupon on a ₹200 course takes ₹200 off, not ₹500 off the whole basket. */
  it('never discounts more than the items it applies to', () => {
    const ctx = context({
      coupon: coupon({ kind: 'FIXED', value: 500_00, currency: 'INR' }),
      eligibleSubtotalMinor: 200_00,
    });
    expect(applyCoupon(ctx)).toEqual({ ok: true, discountMinor: 200_00 });
  });

  describe('every reason it is refused', () => {
    const cases: [string, Partial<CouponContext>, string][] = [
      ['switched off', { coupon: coupon({ active: false }) }, CouponRejection.Inactive],
      [
        'not started yet',
        { coupon: coupon({ startsAt: new Date(NOW.getTime() + 1000) }) },
        CouponRejection.NotStarted,
      ],
      ['expired', { coupon: coupon({ endsAt: NOW }) }, CouponRejection.Expired],
      [
        'a fixed amount in another currency',
        { coupon: coupon({ kind: 'FIXED', value: 500, currency: 'USD' }), currency: 'INR' },
        CouponRejection.CurrencyMismatch,
      ],
      [
        // `value` on a FIXED coupon is minor units, and minor units of *what* is the whole
        // question. 50000 meant as ₹500 would take $500 off a USD cart.
        'a fixed amount with no currency at all',
        { coupon: coupon({ kind: 'FIXED', value: 500_00, currency: null }), currency: 'USD' },
        CouponRejection.CurrencyMismatch,
      ],
      [
        'restricted to courses that are not in the cart',
        { eligibleSubtotalMinor: 0 },
        CouponRejection.NotApplicable,
      ],
      [
        'fully redeemed globally',
        { coupon: coupon({ maxRedemptions: 100 }), globalRedemptions: 100 },
        CouponRejection.GlobalLimitReached,
      ],
      ['already used by this learner', { userRedemptions: 1 }, CouponRejection.UserLimitReached],
    ];

    it.each(cases)('refuses one that is %s', (_label, over, reason) => {
      expect(applyCoupon(context(over))).toEqual({ ok: false, reason });
    });
  });

  describe('the boundaries, which is where these are usually wrong', () => {
    it('is valid at the instant it starts and dead at the instant it ends', () => {
      expect(applyCoupon(context({ coupon: coupon({ startsAt: NOW }) })).ok).toBe(true);
      expect(applyCoupon(context({ coupon: coupon({ endsAt: NOW }) })).ok).toBe(false);
    });

    it('allows the last redemption and refuses the one after', () => {
      const capped = coupon({ maxRedemptions: 100 });
      expect(applyCoupon(context({ coupon: capped, globalRedemptions: 99 })).ok).toBe(true);
      expect(applyCoupon(context({ coupon: capped, globalRedemptions: 100 })).ok).toBe(false);
    });

    /** A PERCENT coupon carries no currency and works on any order. */
    it('does not apply the currency rule to a percentage', () => {
      expect(applyCoupon(context({ currency: 'USD' })).ok).toBe(true);
    });
  });

  /** Every gate runs before the amount is computed, so nothing can leak a discount. */
  it('never returns a discount from a coupon it refused', () => {
    const result = applyCoupon(context({ coupon: coupon({ active: false }) }));
    expect(result).not.toHaveProperty('discountMinor');
  });
});

describe('eligibleItems', () => {
  const items = [{ courseId: 'a' }, { courseId: 'b' }, { courseId: 'c' }];

  it('treats an empty restriction as every course', () => {
    expect(eligibleItems({ courseIds: [] }, items)).toEqual(items);
  });

  it('keeps only the named courses', () => {
    expect(eligibleItems({ courseIds: ['a', 'c'] }, items)).toEqual([
      { courseId: 'a' },
      { courseId: 'c' },
    ]);
  });

  it('is empty when the restriction matches nothing in the cart', () => {
    expect(eligibleItems({ courseIds: ['z'] }, items)).toEqual([]);
  });
});
