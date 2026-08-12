import { query } from '../config/database.js'

/**
 * Shared QR pickup-token revocation — every place an order's active pickup
 * credential must stop working: rider reassignment (finalize-assignment),
 * the order being cancelled, the order being delivered, and a shop-staff
 * rider reassignment. One SQL statement, called from inside each caller's
 * existing transaction rather than duplicated per call site.
 */
export async function revokeOrderPickupTokens(client, orderId, reason) {
  await client.query(
    `UPDATE order_pickup_tokens
     SET status = 'REVOKED', revoked_at = NOW(), revoked_reason = $2
     WHERE order_id = $1 AND status IN ('ACTIVE', 'VERIFIED')`,
    [orderId, reason]
  )
}

/**
 * The raw token for invoice-QR embedding — shared by both the admin and
 * customer-facing invoice endpoints. Deliberately separate from any
 * admin-JSON-response query: this carries the raw credential and must
 * never be serialized back through the admin API (item 14: "do not expose
 * raw signatures in the admin UI"). Only ACTIVE (still-scannable) tokens
 * are returned — VERIFIED/CONSUMED/REVOKED/EXPIRED means there's nothing
 * meaningful left to print, so the invoice's QR block is skipped entirely.
 */
export async function getActivePickupToken(orderId) {
  const { rows } = await query(
    `SELECT delivery_assignment_id, token, version
     FROM order_pickup_tokens
     WHERE order_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId]
  )
  return rows[0] || null
}
