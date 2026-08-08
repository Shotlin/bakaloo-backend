import { query } from '../../../config/database.js'

/**
 * Area Segments repository — admin-defined zones, each with exactly one
 * assigned rider, covering a set of exact (customer, saved address) pairs.
 * Structurally mirrors customer-segments.repository.js; the membership
 * grain is (user_id, address_id) rather than user_id alone, since a
 * segment must never apply just because the customer exists in it — the
 * exact saved address has to match too (see rider-assignment resolver).
 */
export class AreaSegmentsRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT s.id, s.name, s.description, s.is_active, s.rider_id, s.priority,
              r.name AS rider_name, r.phone AS rider_phone,
              s.created_by, s.updated_by, s.created_at, s.updated_at,
              COALESCE(a.address_count, 0)::int AS address_count
       FROM area_segments s
       LEFT JOIN users r ON r.id = s.rider_id
       LEFT JOIN (
         SELECT segment_id, COUNT(*)::int AS address_count
         FROM area_segment_addresses
         GROUP BY segment_id
       ) a ON a.segment_id = s.id
       ORDER BY s.created_at DESC`
    )
    return rows
  }

  async findById(id) {
    const { rows } = await query(
      `SELECT s.id, s.name, s.description, s.is_active, s.rider_id, s.priority,
              r.name AS rider_name, r.phone AS rider_phone,
              s.created_by, s.updated_by, s.created_at, s.updated_at,
              COALESCE(a.address_count, 0)::int AS address_count
       FROM area_segments s
       LEFT JOIN users r ON r.id = s.rider_id
       LEFT JOIN (
         SELECT segment_id, COUNT(*)::int AS address_count
         FROM area_segment_addresses
         GROUP BY segment_id
       ) a ON a.segment_id = s.id
       WHERE s.id = $1`,
      [id]
    )
    return rows[0] ?? null
  }

  async create({ name, description, riderId, priority, createdBy }) {
    const { rows } = await query(
      `INSERT INTO area_segments (name, description, rider_id, priority, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING id, name, description, is_active, rider_id, priority, created_by, updated_by, created_at, updated_at`,
      [name, description ?? null, riderId ?? null, priority ?? 0, createdBy ?? null]
    )
    return { ...rows[0], address_count: 0, rider_name: null, rider_phone: null }
  }

  async update(id, data, updatedBy) {
    const fields = []
    const params = []
    let idx = 1

    const fieldMap = { name: 'name', description: 'description', isActive: 'is_active', riderId: 'rider_id', priority: 'priority' }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_by = $${idx++}`, `updated_at = NOW()`)
    params.push(updatedBy ?? null)
    params.push(id)

    const { rows } = await query(
      `UPDATE area_segments SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id`,
      params
    )
    if (!rows[0]) return null
    return this.findById(id)
  }

  async delete(id) {
    const result = await query(`DELETE FROM area_segments WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  async findAddresses(segmentId, { limit, offset }) {
    const { rows } = await query(
      `SELECT a.id, a.user_id, a.address_id, a.lat, a.lng, a.added_at,
              u.name AS customer_name, u.phone AS customer_phone,
              addr.label, addr.address_line1, addr.address_line2, addr.city, addr.pincode
       FROM area_segment_addresses a
       INNER JOIN users u ON u.id = a.user_id
       LEFT JOIN addresses addr ON addr.id = a.address_id
       WHERE a.segment_id = $1
       ORDER BY a.added_at DESC
       LIMIT $2 OFFSET $3`,
      [segmentId, limit, offset]
    )
    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM area_segment_addresses WHERE segment_id = $1`,
      [segmentId]
    )
    return { addresses: rows, total: countRows[0].total }
  }

  /**
   * Adds one exact (customer, saved address) pair to a segment. Snapshots
   * lat/lng from the addresses row at add-time — a display/fallback
   * convenience, not the primary match key (address_id is).
   */
  async addAddress(segmentId, { userId, addressId, addedBy }) {
    const { rows: [addr] } = await query(
      `SELECT lat, lng FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [addressId, userId]
    )
    if (!addr) return { success: false, message: 'Address not found for this customer' }

    const { rows } = await query(
      `INSERT INTO area_segment_addresses (segment_id, user_id, address_id, lat, lng, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (segment_id, address_id) DO NOTHING
       RETURNING id`,
      [segmentId, userId, addressId, addr.lat, addr.lng, addedBy ?? null]
    )
    return { success: true, added: rows.length > 0 }
  }

  async removeAddress(segmentId, addressId) {
    const result = await query(
      `DELETE FROM area_segment_addresses WHERE segment_id = $1 AND address_id = $2`,
      [segmentId, addressId]
    )
    return result.rowCount > 0
  }

  /** "View all active orders associated with the segment" (admin visibility requirement). */
  async findActiveOrders(segmentId) {
    const { rows } = await query(
      `SELECT o.id, o.order_number, o.status, o.rider_id, o.assignment_method, o.assigned_at,
              u.name AS customer_name, ru.name AS rider_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN users ru ON ru.id = o.rider_id
       WHERE o.area_segment_id = $1
         AND o.status NOT IN ('DELIVERED', 'CANCELLED', 'REFUNDED')
       ORDER BY o.created_at DESC`,
      [segmentId]
    )
    return rows
  }

  /** Segments matching an exact (customer, address) pair — surfaced for the "detect conflicting segments" admin view. */
  async findSegmentsForAddress(userId, addressId) {
    const { rows } = await query(
      `SELECT s.id, s.name, s.is_active, s.priority
       FROM area_segments s
       JOIN area_segment_addresses a ON a.segment_id = s.id
       WHERE a.user_id = $1 AND a.address_id = $2
       ORDER BY s.priority DESC, s.created_at ASC`,
      [userId, addressId]
    )
    return rows
  }
}
