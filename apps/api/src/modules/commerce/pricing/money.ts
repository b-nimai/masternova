/**
 * Money arithmetic, in minor units, with the rounding decided once.
 *
 * Every amount in this module is an integer count of the currency's smallest unit — paise
 * for INR, cents for USD. Never a float, never a decimal of rupees. Razorpay's API takes
 * integer paise, so this is the representation that needs no conversion at the one boundary
 * where a rounding error becomes a chargeback.
 */

/** Percentages are basis points out of 10,000, so 12.5% is 1250 and needs no float. */
export const BASIS_POINTS = 10_000;

/**
 * A percentage discount, rounded **down**, so rounding always favours the learner.
 *
 * The direction has to be a decision rather than whatever `Math.round` does: rounding a
 * discount up costs the platform a paise, rounding it down costs the learner one, and the
 * one thing that must never happen is the two differing between the quote the learner saw
 * and the amount the provider is asked to capture.
 */
export function percentOff(amountMinor: number, basisPoints: number): number {
  return Math.floor((amountMinor * basisPoints) / BASIS_POINTS);
}

/** A discount never exceeds what is being discounted, and is never negative. */
export function clampDiscount(discountMinor: number, subtotalMinor: number): number {
  return Math.max(0, Math.min(discountMinor, subtotalMinor));
}

/**
 * Spread an order-level discount across its line items so they sum **exactly** to the total.
 *
 * **Why this exists.** A coupon applies to the order; an invoice prints line items. Dividing
 * proportionally and rounding each line independently loses or gains paise — three lines
 * sharing a ₹100 discount at ⅓ each round to 3333+3333+3333 = 9999, and the invoice is one
 * paise short of what was charged. That discrepancy is exactly what an accountant finds.
 *
 * The remainder is given to the **largest** line rather than the first, so the adjustment
 * lands where it is proportionally smallest and least visible.
 */
export function allocateDiscount(
  lineAmountsMinor: readonly number[],
  totalDiscountMinor: number,
): number[] {
  const subtotal = lineAmountsMinor.reduce((sum, amount) => sum + amount, 0);
  if (subtotal <= 0 || totalDiscountMinor <= 0) return lineAmountsMinor.map(() => 0);

  const capped = clampDiscount(totalDiscountMinor, subtotal);
  const shares = lineAmountsMinor.map((amount) => Math.floor((amount * capped) / subtotal));

  let remainder = capped - shares.reduce((sum, share) => sum + share, 0);

  // Hand the leftover paise out one at a time, largest line first. A loop rather than
  // dumping it all on one line: with four lines and a 3-paise remainder, three different
  // lines should absorb one paise each.
  const order = lineAmountsMinor
    .map((amount, index) => ({ amount, index }))
    .sort((a, b) => b.amount - a.amount || a.index - b.index);

  for (let i = 0; remainder > 0; i = (i + 1) % order.length) {
    const target = order[i].index;
    // Never push a line's discount past the line itself.
    if (shares[target] < lineAmountsMinor[target]) {
      shares[target] += 1;
      remainder -= 1;
    } else if (order.every(({ index }) => shares[index] >= lineAmountsMinor[index])) {
      break;
    }
  }

  return shares;
}
