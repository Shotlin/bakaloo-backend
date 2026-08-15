import { query } from '../../config/database.js'

/**
 * Read-side queries for the assignment resolver's tier 2 (area segment)
 * and tier 3 (general auto) logic, plus the decision audit log.
 * Transactional writes (delivery_assignments, orders, pickup tokens,
 * notification dispatch) live in finalize-assignment.repository.js —
 * kept separate because the resolver only ever reads here, while
 * finalize is the sole writer, matching this codebase's existing
 * repository-per-responsibility layering.
 */
export class RiderAssignmentRepository {
  /**
   * Every ACTIVE area segment whose address list contains this exact
   * (customer, saved address) pair, ordered by the documented conflict
   * fallback: higher priority first, then oldest segment first. Item 13
   * requires detecting/logging conflicts rather than silently picking —
   * callers get the full ordered list so they can tell "one match" from
   * "N matches, picked the first by priority/created_at" for the log.
   */
  async findMatchingSegments(userId, addressId) {
    const { rows } = await query(
      `SELECT s.id, s.name, s.rider_id, s.priority, s.created_at
       FROM area_segments s
       JOIN area_segment_addresses a ON a.segment_id = s.id
       WHERE s.is_active = true
         AND a.user_id = $1
         AND a.address_id = $2
       ORDER BY s.priority DESC, s.created_at ASC`,
      [userId, addressId]
    )
    return rows
  }

  /**
   * The rider an admin picked the last time this exact customer ordered
   * to this exact saved address, if any — `customer_address_rider_preferences`,
   * kept up to date on every manual (re)assign in orders.service.js.
   * Independent of area segments (an admin-configured zone→rider map);
   * this is per-address history, auto-assigned the same way — respects
   * capacity, ignores online status — so a returning customer's usual
   * rider doesn't need an admin to click Assign every single time.
   */
  async findStickyAddressPreference(userId, addressId) {
    const { rows } = await query(
      `SELECT rider_id FROM customer_address_rider_preferences
       WHERE user_id = $1 AND address_id = $2`,
      [userId, addressId]
    )
    return rows[0]?.rider_id ?? null
  }

  /** Global default capacity (app_settings.rider_max_active_orders), falling back to 4 if unseeded. */
  async getGlobalDefaultCapacity() {
    const { rows } = await query(
      `SELECT value FROM app_settings WHERE key = 'rider_max_active_orders'`
    )
    const parsed = Number(rows[0]?.value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 4
  }

  /** Count of an individual rider's currently non-terminal deliveries — the capacity denominator. */
  async countActiveOrders(riderId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
       FROM delivery_assignments
       WHERE rider_id = $1 AND status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')`,
      [riderId]
    )
    return rows[0]?.count ?? 0
  }

  /**
   * Tier-3 candidate pool: approved, online, active, connected to the
   * order's store, below capacity (per-rider override else the global
   * default), with their current active-order count and last-known
   * location for the caller to rank by workload -> distance -> fairness.
   * Distance itself is computed in JS (haversineDistanceKm) once the
   * candidate rows are back, matching the existing worker's approach —
   * not pushed into SQL, since live location may come from Redis and not
   * just the rider_profiles snapshot (see resolver service).
   */
  async getEligibleAutoCandidates(shopId, globalDefaultCapacity) {
    const { rows } = await query(
      `SELECT rp.user_id AS rider_id, rp.current_lat, rp.current_lng,
              rp.last_assigned_at,
              COALESCE(rp.max_active_orders, $2) AS capacity,
              COALESCE(active.count, 0)::int AS active_count
       FROM rider_profiles rp
       JOIN users u ON u.id = rp.user_id
       LEFT JOIN (
         SELECT rider_id, COUNT(*)::int AS count
         FROM delivery_assignments
         WHERE status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')
         GROUP BY rider_id
       ) active ON active.rider_id = rp.user_id
       WHERE rp.is_approved = true
         AND rp.is_online = true
         AND u.is_active = true
         AND rp.shop_id = $1
         AND COALESCE(active.count, 0) < COALESCE(rp.max_active_orders, $2)`,
      [shopId, globalDefaultCapacity]
    )
    return rows
  }

  /**
   * Same pool but for a segment-assigned rider, who must still respect
   * capacity (per the "respect capacity, ignore online status" decision)
   * even though they skip the online/approved/store-connected filters a
   * general auto candidate needs.
   */
  async getRiderCapacityStatus(riderId, globalDefaultCapacity) {
    const { rows } = await query(
      `SELECT COALESCE(rp.max_active_orders, $2) AS capacity,
              COALESCE(active.count, 0)::int AS active_count
       FROM rider_profiles rp
       LEFT JOIN (
         SELECT rider_id, COUNT(*)::int AS count
         FROM delivery_assignments
         WHERE status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')
         GROUP BY rider_id
       ) active ON active.rider_id = rp.user_id
       WHERE rp.user_id = $1`,
      [riderId, globalDefaultCapacity]
    )
    return rows[0] || null
  }

  async logDecision({ orderId, riderId, method, reason, triggeredBy }) {
    await query(
      `INSERT INTO rider_assignment_log (order_id, rider_id, method, reason, triggered_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, riderId ?? null, method, reason ?? null, triggeredBy ?? 'SYSTEM']
    )
  }

  async getAssignmentHistory(orderId) {
    const { rows } = await query(
      `SELECT ral.*, u.name AS rider_name
       FROM rider_assignment_log ral
       LEFT JOIN users u ON u.id = ral.rider_id
       WHERE ral.order_id = $1
       ORDER BY ral.decided_at ASC`,
      [orderId]
    )
    return rows
  }
}
