import { getClient, query } from '../../config/database.js'
import { revokeOrderPickupTokens } from '../../utils/pickupTokens.js'

/**
 * The sole writer for committing a rider assignment — used by every tier
 * of the resolver (manual/segment/auto) and replacing the previously
 * duplicated INSERT/UPDATE pairs in orders.repository.js#assignRider,
 * bulkAssign, and workers/processors.js#handleAutoAssign.
 */
export class FinalizeAssignmentRepository {
  async getClient() {
    return getClient()
  }

  /** Row-level lock so concurrent finalize calls for the same order can't double-assign. */
  async lockOrder(client, orderId) {
    const { rows } = await client.query(
      `SELECT id, user_id, shop_id, rider_id, status, assignment_method,
              delivery_address, delivery_fee, order_number
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    )
    return rows[0] || null
  }

  /** Cancels any still-open assignment for this order (reassignment path) — mirrors the existing assignRider pattern. */
  async cancelOpenAssignment(client, orderId, reason) {
    const { rows } = await client.query(
      `UPDATE delivery_assignments
       SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = NOW(), updated_at = NOW()
       WHERE order_id = $1 AND status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')
       RETURNING id, rider_id`,
      [orderId, reason]
    )
    return rows
  }

  async revokeActiveTokens(client, orderId, reason) {
    await revokeOrderPickupTokens(client, orderId, reason)
  }

  async insertAssignment(client, orderId, riderId, earnings) {
    const { rows } = await client.query(
      `INSERT INTO delivery_assignments (order_id, rider_id, status, assigned_at, earnings)
       VALUES ($1, $2, 'ASSIGNED', NOW(), $3)
       RETURNING id, order_id, rider_id, status, assigned_at`,
      [orderId, riderId, earnings]
    )
    return rows[0]
  }

  async updateOrderAssignment(client, orderId, { riderId, method, areaSegmentId }) {
    await client.query(
      `UPDATE orders
       SET rider_id = $2, assignment_method = $3, assigned_at = NOW(),
           area_segment_id = $4, updated_at = NOW()
       WHERE id = $1`,
      [orderId, riderId, method, areaSegmentId ?? null]
    )
  }

  async mintToken(client, { orderId, assignmentId, token, version, expiresAt }) {
    const { rows } = await client.query(
      `INSERT INTO order_pickup_tokens (order_id, delivery_assignment_id, token, version, status, expires_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5)
       RETURNING id, token, version, expires_at`,
      [orderId, assignmentId, token, version, expiresAt ?? null]
    )
    return rows[0]
  }

  /**
   * Guarded dedup: only returns true (meaning "go ahead and push") the
   * first time this assignment is marked. A single UPDATE...RETURNING is
   * already atomic on its own, so this deliberately runs standalone
   * (post-commit), not inside the assignment transaction — sending a push
   * is an external side effect that shouldn't hold a DB transaction open.
   */
  async claimNotificationSlot(assignmentId) {
    const { rows } = await query(
      `UPDATE delivery_assignments
       SET notification_sent_at = NOW()
       WHERE id = $1 AND notification_sent_at IS NULL
       RETURNING id`,
      [assignmentId]
    )
    return rows.length > 0
  }

  async setManualRequired(orderId) {
    await query(
      `UPDATE orders SET auto_assignment_status = 'MANUAL_REQUIRED', updated_at = NOW() WHERE id = $1`,
      [orderId]
    )
  }

  async getRiderFcmTokens(riderId) {
    const { rows } = await query('SELECT token FROM fcm_tokens WHERE user_id = $1', [riderId])
    return rows.map((r) => r.token)
  }

  async updateLastAssignedAt(client, riderId) {
    await client.query(
      `UPDATE rider_profiles SET last_assigned_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
      [riderId]
    )
  }
}
