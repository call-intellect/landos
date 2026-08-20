/**
 * Discount application. Given a base amount and a discount, returns how much
 * money is taken off. Pricing totals are computed elsewhere; this function only
 * decides the reduction.
 */

import type { Discount } from "./order.schema.js";

/**
 * Returns the reduction (never negative, never larger than the base amount)
 * that the given discount produces for `baseAmount`.
 */
export function applyDiscount(baseAmount: number, discount?: Discount): number {
  if (!discount || discount.kind === "none" || baseAmount <= 0) {
    return 0;
  }

  let reduction = 0;
  if (discount.kind === "percent") {
    const clampedPercent = Math.min(Math.max(discount.value, 0), 100);
    reduction = (baseAmount * clampedPercent) / 100;
  } else if (discount.kind === "fixed") {
    reduction = Math.max(discount.value, 0);
  }

  return roundMoney(Math.min(reduction, baseAmount));
}

export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}
