import { allocateDiscount, clampDiscount, percentOff } from './money';

describe('money', () => {
  describe('percentOff', () => {
    it('takes basis points, so 12.5% needs no float', () => {
      expect(percentOff(100_00, 1250)).toBe(12_50);
    });

    /** Rounding down costs the platform a paise; rounding up overcharges the learner. */
    it('always rounds in the learner’s favour', () => {
      // 33.33% of ₹10.00 is 333.3 paise.
      expect(percentOff(1000, 3333)).toBe(333);
    });

    it('is exact at the boundaries', () => {
      expect(percentOff(249900, 0)).toBe(0);
      expect(percentOff(249900, 10_000)).toBe(249900);
    });
  });

  describe('clampDiscount', () => {
    it('never exceeds what it discounts, and never goes negative', () => {
      expect(clampDiscount(50_000, 20_000)).toBe(20_000);
      expect(clampDiscount(-5, 20_000)).toBe(0);
      expect(clampDiscount(7_000, 20_000)).toBe(7_000);
    });
  });

  describe('allocateDiscount', () => {
    /**
     * The property that matters. Rounding each line independently loses paise, and an
     * invoice whose lines do not sum to the amount charged is what an accountant finds.
     */
    it('always sums exactly to the discount', () => {
      const cases: [number[], number][] = [
        [[10_000, 10_000, 10_000], 10_000],
        [[333, 333, 334], 100],
        [[1, 1, 1], 2],
        [[249900, 99900, 149900], 77777],
        [[100], 1],
        [[5_000, 15_000], 3],
      ];

      for (const [lines, discount] of cases) {
        const shares = allocateDiscount(lines, discount);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(discount);
      }
    });

    it('never gives a line more discount than the line is worth', () => {
      const shares = allocateDiscount([100, 100, 10_000], 400);
      shares.forEach((share, i) => expect(share).toBeLessThanOrEqual([100, 100, 10_000][i]));
      expect(shares.reduce((a, b) => a + b, 0)).toBe(400);
    });

    it('caps at the subtotal when the discount exceeds it', () => {
      const shares = allocateDiscount([100, 200], 5_000);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(300);
    });

    it('hands the remainder to the largest line', () => {
      // ₹1 across 3+3+4 → floor gives 0/0/0 with 1 left; the 4 takes it.
      expect(allocateDiscount([3, 3, 4], 1)).toEqual([0, 0, 1]);
    });

    it('spreads a multi-paise remainder across different lines', () => {
      const shares = allocateDiscount([1000, 1000, 1000], 4);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(4);
      // Not all four paise on one line.
      expect(Math.max(...shares)).toBeLessThan(4);
    });

    it('is all zeros for a free order or no discount', () => {
      expect(allocateDiscount([0, 0], 500)).toEqual([0, 0]);
      expect(allocateDiscount([100, 200], 0)).toEqual([0, 0]);
    });
  });
});
