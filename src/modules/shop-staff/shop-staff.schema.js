import { z } from 'zod'

/**
 * Shop Staff module — Zod validation schemas
 * Mirrors columns and constraints from migration 030_shop_staff.sql
 */

// Valid permissions for shop staff (Requirement 2.4)
export const VALID_PERMISSIONS = [
  'manage_products',
  'manage_orders',
  'manage_inventory',
  'view_financials',
  'manage_financials',
  'manage_staff',
  'manage_settings',
  'manage_customers',
  'manage_riders',
]

// Valid shop staff roles (Requirement 2.1)
export const VALID_ROLES = ['SHOP_ADMIN', 'SHOP_MANAGER', 'SHOP_STAFF', 'SHOP_VIEWER']

// ─── CREATE SHOP STAFF ───────────────────────────────────
// shop_id is currently accepted from the request body. Task 2.3 will introduce
// the shop-scope middleware which derives shop_id from the JWT and ignores body.
export const createShopStaffSchema = z.object({
  shop_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: z.enum(VALID_ROLES),
  permissions: z
    .array(z.enum(VALID_PERMISSIONS))
    .max(VALID_PERMISSIONS.length)
    .default([]),
})

// ─── UPDATE SHOP STAFF ───────────────────────────────────
export const updateShopStaffSchema = z
  .object({
    role: z.enum(VALID_ROLES).optional(),
    permissions: z
      .array(z.enum(VALID_PERMISSIONS))
      .max(VALID_PERMISSIONS.length)
      .optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.role !== undefined ||
      data.permissions !== undefined ||
      data.is_active !== undefined,
    { message: 'At least one of role, permissions, or is_active must be provided' }
  )

// ─── LIST SHOP STAFF QUERY ───────────────────────────────
export const listShopStaffQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(VALID_ROLES).optional(),
  is_active: z.enum(['true', 'false']).optional(),
  // Requirement 15.3 — Shop Admin opt-in to surface soft-deleted staff
  // records in admin "show deleted" / restoration views. Excluded by default.
  include_deleted: z.enum(['true', 'false']).optional(),
})

// ─── PARAMS ──────────────────────────────────────────────
export const shopStaffIdParamSchema = z.object({
  id: z.string().uuid(),
})
