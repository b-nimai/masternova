import type { Coupon } from '@masternova/db';
import { MixedCurrencyCartException } from '../../../common/exceptions';
import type {
  ICouponRepository,
  PurchasableCourse,
} from '../repositories/commerce.repository.interface';
import { PricingService } from './pricing.service';

const NOW = new Date('2026-09-03T12:00:00.000Z');

const course = (over: Partial<PurchasableCourse> = {}): PurchasableCourse => ({
  id: 'course-1',
  title: 'Kubernetes in anger',
  status: 'PUBLISHED',
  priceMinor: 100_00,
  priceSetAt: NOW,
  currency: 'INR',
  instructorId: 'instructor-1',
  ...over,
});

/** A fake repository, not a mock of Prisma — the service is tested with no database (§6). */
class FakeCoupons implements ICouponRepository {
  coupons: Coupon[] = [];
  counts = { global: 0, forUser: 0 };
  redeemed: unknown[] = [];

  findByCode(code: string) {
    return Promise.resolve(
      this.coupons.find((c) => c.code.toLowerCase() === code.trim().toLowerCase()) ?? null,
    );
  }
  countRedemptions() {
    return Promise.resolve(this.counts);
  }
  redeem(input: unknown) {
    this.redeemed.push(input);
    return Promise.resolve();
  }
  release() {
    return Promise.resolve();
  }
}

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

describe('PricingService', () => {
  let coupons: FakeCoupons;
  let pricing: PricingService;

  beforeEach(() => {
    coupons = new FakeCoupons();
    pricing = new PricingService(coupons);
  });

  const quote = (courses: PurchasableCourse[], couponCode?: string) =>
    pricing.quote({ courses, userId: 'user-1', couponCode, now: NOW });

  it('sums the line prices with no coupon', async () => {
    const result = await quote([course(), course({ id: 'course-2', priceMinor: 50_00 })]);

    expect(result.subtotalMinor).toBe(150_00);
    expect(result.discountMinor).toBe(0);
    expect(result.totalMinor).toBe(150_00);
  });

  it('prices an empty cart at zero rather than failing', async () => {
    const result = await quote([]);
    expect(result.totalMinor).toBe(0);
    expect(result.currency).toBe('INR');
  });

  /** There is no exchange rate this platform is willing to be wrong about. */
  it('refuses a cart that mixes currencies', async () => {
    await expect(quote([course(), course({ id: 'c2', currency: 'USD' })])).rejects.toThrow(
      MixedCurrencyCartException,
    );
  });

  describe('with a coupon', () => {
    it('applies a percentage across the whole cart', async () => {
      coupons.coupons = [coupon()];
      const result = await quote(
        [course(), course({ id: 'course-2', priceMinor: 50_00 })],
        'LAUNCH50',
      );

      expect(result.discountMinor).toBe(75_00);
      expect(result.totalMinor).toBe(75_00);
      expect(result.coupon?.code).toBe('LAUNCH50');
    });

    it('finds the code however the learner capitalised it', async () => {
      coupons.coupons = [coupon()];
      expect((await quote([course()], '  launch50 ')).discountMinor).toBe(50_00);
    });

    /**
     * The property `allocateDiscount` exists for: the line discounts must sum to the order
     * discount exactly, or an invoice is a paise short of what was charged.
     */
    it('spreads the discount across lines so they sum to the total', async () => {
      coupons.coupons = [coupon({ kind: 'FIXED', value: 100, currency: 'INR' })];
      const result = await quote(
        [
          course({ id: 'a', priceMinor: 333 }),
          course({ id: 'b', priceMinor: 333 }),
          course({ id: 'c', priceMinor: 334 }),
        ],
        'LAUNCH50',
      );

      const lineSum = result.lines.reduce((sum, line) => sum + line.discountMinor, 0);
      expect(lineSum).toBe(result.discountMinor);
      expect(result.subtotalMinor - result.discountMinor).toBe(result.totalMinor);
    });

    it('discounts only the courses a restricted coupon names', async () => {
      coupons.coupons = [coupon({ courseIds: ['course-2'] })];
      const result = await quote(
        [
          course({ id: 'course-1', priceMinor: 100_00 }),
          course({ id: 'course-2', priceMinor: 40_00 }),
        ],
        'LAUNCH50',
      );

      expect(result.discountMinor).toBe(20_00);
      expect(result.lines.find((l) => l.courseId === 'course-1')?.discountMinor).toBe(0);
      expect(result.lines.find((l) => l.courseId === 'course-2')?.discountMinor).toBe(20_00);
    });

    /**
     * A bad code must not fail the quote. Refusing to price the cart at all is a worse answer
     * to "I typed a coupon that expired" than showing the price plus a reason.
     */
    it('still prices the cart when the code is refused, and says why', async () => {
      coupons.coupons = [coupon({ active: false })];
      const result = await quote([course()], 'LAUNCH50');

      expect(result.totalMinor).toBe(100_00);
      expect(result.discountMinor).toBe(0);
      expect(result.couponRejection).toBe('COUPON_INACTIVE');
      expect(result.coupon).toBeUndefined();
    });

    it('reports a code that does not exist without throwing', async () => {
      expect((await quote([course()], 'NOPE')).couponRejection).toBe('COUPON_NOT_FOUND');
    });

    it('can take an order to exactly zero', async () => {
      coupons.coupons = [coupon({ value: 10_000 })];
      const result = await quote([course()], 'LAUNCH50');

      expect(result.totalMinor).toBe(0);
      expect(result.discountMinor).toBe(100_00);
    });

    it('refuses a coupon this learner has already used', async () => {
      coupons.coupons = [coupon()];
      coupons.counts = { global: 5, forUser: 1 };

      expect((await quote([course()], 'LAUNCH50')).couponRejection).toBe('COUPON_ALREADY_USED');
    });
  });
});
