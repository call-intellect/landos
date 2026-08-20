/**
 * Order data shapes for the pricing endpoints.
 */

import { z } from "zod";

export interface OrderItem {
  sku: string;
  title: string;
  unitPrice: number;
  quantity: number;
}

export type DiscountKind = "none" | "percent" | "fixed";

export interface Discount {
  kind: DiscountKind;
  value: number;
}

export interface OrderInput {
  items: OrderItem[];
  discount?: Discount;
  currency?: string;
}

export interface Order {
  id: string;
  items: OrderItem[];
  subtotal: number;
  discountAmount: number;
  total: number;
  currency: string;
  createdAt: string;
}

export const orderItemSchema = z.object({
  sku: z.string().min(1),
  title: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  quantity: z.number().int().positive(),
});

export const orderInputSchema = z.object({
  items: z.array(orderItemSchema).min(1),
  discount: z
    .object({
      kind: z.enum(["none", "percent", "fixed"]),
      value: z.number().nonnegative(),
    })
    .optional(),
  currency: z.string().length(3).optional(),
});
