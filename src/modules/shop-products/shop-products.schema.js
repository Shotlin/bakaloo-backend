import { z } from 'zod'

/**
 * Shop Products module — Zod validation schemas
 * Mirrors columns and constraints from migration 031_shop_products.sql
 *
 * Validates: Requirements 3.1, 3.2, 3.5, 3.7, 3.9, 12.1, 12.6
 */

// Numeric ranges from the DB CHECK constraints
const PRICE_MIN = 0.01
const PRICE_MAX = 99999999.99
const COST_PRICE_MIN = 0
const STOCK_MIN = 0
const STOCK_MAX = 2147483647 // INT4 max
const LOW_STOCK_MIN = 0
const MAX_ORDER_QTY_MIN = 1
const MAX_ORDER_QTY_MAX = 10000

// ─── CREATE SHOP PRODUCT ─────────────────────────────────
// shop_id is derived from request.shopId (JWT/header) by the controller —
// the body provides product-specific fields only.
export const createShopProductSchema = z
  .object({
    product_id: z.string().uuid(),
    price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    sale_price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    cost_price: z.number().min(COST_PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    stock_quantity: z.number().int().min(STOCK_MIN).max(STOCK_MAX).default(0),
    low_stock_threshold: z.number().int().min(LOW_STOCK_MIN).default(5),
    max_order_qty: z
      .number()
      .int()
      .min(MAX_ORDER_QTY_MIN)
      .max(MAX_ORDER_QTY_MAX)
      .default(50),
    is_available: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    // Requirement 3.9 — sale_price must be < price when both are set
    if (
      data.price !== undefined &&
      data.price !== null &&
      data.sale_price !== undefined &&
      data.sale_price !== null &&
      data.sale_price >= data.price
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sale_price'],
        message: 'sale_price must be less than price',
      })
    }
  })

// ─── UPDATE SHOP PRODUCT ─────────────────────────────────
// Excludes stock_quantity (use the dedicated stock-update endpoint that takes
// SELECT FOR UPDATE row-level locks — Requirement 3.8).
export const updateShopProductSchema = z
  .object({
    price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    sale_price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    cost_price: z.number().min(COST_PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    low_stock_threshold: z.number().int().min(LOW_STOCK_MIN).optional(),
    max_order_qty: z
      .number()
      .int()
      .min(MAX_ORDER_QTY_MIN)
      .max(MAX_ORDER_QTY_MAX)
      .optional(),
    is_available: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.price !== undefined ||
      data.sale_price !== undefined ||
      data.cost_price !== undefined ||
      data.low_stock_threshold !== undefined ||
      data.max_order_qty !== undefined ||
      data.is_available !== undefined,
    { message: 'At least one field must be provided' }
  )

// ─── STOCK UPDATE ────────────────────────────────────────
// Two modes: absolute set (`stock_quantity`) or delta (`delta`, +/-).
// Either-or: exactly one must be provided.
export const stockUpdateSchema = z
  .object({
    stock_quantity: z.number().int().min(STOCK_MIN).max(STOCK_MAX).optional(),
    delta: z.number().int().optional(),
    reason: z.string().max(200).optional(),
  })
  .refine(
    (data) =>
      (data.stock_quantity !== undefined && data.delta === undefined) ||
      (data.stock_quantity === undefined && data.delta !== undefined),
    { message: 'Exactly one of stock_quantity or delta must be provided' }
  )

// ─── LIST QUERY ──────────────────────────────────────────
export const listShopProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  is_available: z.enum(['true', 'false']).optional(),
  low_stock: z.enum(['true', 'false']).optional(),
  search: z.string().max(200).optional(),
  include_deleted: z.enum(['true', 'false']).optional(),
})

// ─── PARAMS ──────────────────────────────────────────────
export const shopProductIdParamSchema = z.object({
  id: z.string().uuid(),
})
