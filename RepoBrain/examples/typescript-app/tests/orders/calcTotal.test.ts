import { describe, expect, it } from "vitest";
import { calcTotal } from "../../src/modules/orders/calcTotal.js";
import { applyDiscount } from "../../src/modules/orders/applyDiscount.js";
import type { OrderItem } from "../../src/modules/orders/order.schema.js";

const items: OrderItem[] = [
  { sku: "A-1", title: "Widget", unitPrice: 10, quantity: 2 },
  { sku: "B-2", title: "Gadget", unitPrice: 5, quantity: 3 },
];

describe("calcTotal", () => {
  it("sums line items when there is no discount", () => {
    const totals = calcTotal(items);
    expect(totals.subtotal).toBe(35);
    expect(totals.discountAmount).toBe(0);
    expect(totals.total).toBe(35);
  });

  it("applies a percent discount via applyDiscount", () => {
    const totals = calcTotal(items, { kind: "percent", value: 10 });
    expect(totals.discountAmount).toBe(3.5);
    expect(totals.total).toBe(31.5);
  });

  it("never discounts below zero", () => {
    const totals = calcTotal(items, { kind: "fixed", value: 1000 });
    expect(totals.total).toBe(0);
  });
});

describe("applyDiscount", () => {
  it("returns zero for the none discount kind", () => {
    expect(applyDiscount(100, { kind: "none", value: 50 })).toBe(0);
  });

  it("clamps percent discounts to at most 100 percent", () => {
    expect(applyDiscount(100, { kind: "percent", value: 250 })).toBe(100);
  });
});
