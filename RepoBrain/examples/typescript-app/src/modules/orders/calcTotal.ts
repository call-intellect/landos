/**
 * Order total calculation. Sums line items, then applies any discount using
 * `applyDiscount` to reach the final amount to charge.
 */

import { applyDiscount, roundMoney } from "./applyDiscount.js";
import type { Discount, Order, OrderItem } from "./order.schema.js";
import { generateId } from "../../common/db.js";

export interface OrderTotals {
  subtotal: number;
  discountAmount: number;
  total: number;
}

/**
 * Sums the price of every line item.
 */
export function calcSubtotal(items: OrderItem[]): number {
  const sum = items.reduce(
    (acc, item) => acc + item.unitPrice * item.quantity,
    0,
  );
  return roundMoney(sum);
}

/**
 * Computes the subtotal, the discount reduction, and the final total for a set
 * of line items. Delegates the discount math to `applyDiscount`.
 */
export function calcTotal(items: OrderItem[], discount?: Discount): OrderTotals {
  const subtotal = calcSubtotal(items);
  const discountAmount = applyDiscount(subtotal, discount);
  const total = roundMoney(subtotal - discountAmount);
  return { subtotal, discountAmount, total };
}

/**
 * Builds a persisted `Order` from line items, currency, and an optional
 * discount, using `calcTotal` for the money math.
 */
export function buildOrder(
  items: OrderItem[],
  discount?: Discount,
  currency = "USD",
): Order {
  const totals = calcTotal(items, discount);
  return {
    id: generateId("order"),
    items,
    subtotal: totals.subtotal,
    discountAmount: totals.discountAmount,
    total: totals.total,
    currency,
    createdAt: new Date().toISOString(),
  };
}
