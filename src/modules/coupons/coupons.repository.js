import { query } from '../../config/database.js'

/**
 * Coupons repository — all SQL queries for coupons
 */
export class CouponsRepository {
  /**
   * Find active coupon by code (case-insensitive)
   */
  async findByCode(code) {
    const { rows } = await query(
      `SELECT id, code, description, discount_type, discount_value, min_order_amount,
              max_discount, usage_limit, used_count, per_user_limit, valid_from, valid_until,
              is_active, created_at
       FROM coupons
       WHERE UPPER(code) = UPPER($1)`,
      [code]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find coupon by ID
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT id, code, description, discount_type, discount_value, min_order_amount,
              max_discount, usage_limit, used_count, per_user_limit, valid_from, valid_until,
              is_active, created_at, updated_at
       FROM coupons WHERE id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Get user's usage count for a coupon
   */
  async getUserUsageCount(couponId, userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM coupon_usages
       WHERE coupon_id = $1 AND user_id = $2`,
      [couponId, userId]
    )
    return rows[0].count
  }

  /**
   * Record coupon usage
   */
  async recordUsage(couponId, userId, orderId) {
    await query(
      `INSERT INTO coupon_usages (coupon_id, user_id, order_id) VALUES ($1, $2, $3)`,
      [couponId, userId, orderId]
    )
    await query(
      `UPDATE coupons SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1`,
      [couponId]
    )
  }

  /**
   * Get all active/valid coupons
   */
  async findAvailable() {
    const { rows } = await query(
      `SELECT id, code, description, discount_type, discount_value, min_order_amount,
              max_discount, usage_limit, used_count, per_user_limit, valid_from, valid_until,
              is_active, created_at
       FROM coupons
       WHERE is_active = true
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
         AND (usage_limit IS NULL OR used_count < usage_limit)
       ORDER BY created_at DESC`
    )
    return rows.map(this._format)
  }

  /**
   * List all coupons — admin (paginated)
   */
  async findAll({ limit, offset }) {
    const { rows } = await query(
      `SELECT id, code, description, discount_type, discount_value, min_order_amount,
              max_discount, usage_limit, used_count, per_user_limit, valid_from, valid_until,
              is_active, created_at
       FROM coupons
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    const { rows: countRows } = await query(`SELECT COUNT(*)::int AS total FROM coupons`)
    return { data: rows.map(this._format), total: countRows[0].total }
  }

  /**
   * Create a coupon
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, min_order_amount,
       max_discount, usage_limit, per_user_limit, valid_from, valid_until)
       VALUES (UPPER($1), $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, code, description, discount_type, discount_value, min_order_amount,
                 max_discount, usage_limit, used_count, per_user_limit, valid_from, valid_until,
                 is_active, created_at`,
      [
        data.code,
        data.description || null,
        data.discountType,
        data.discountValue,
        data.minOrderAmount || 0,
        data.maxDiscount || null,
        data.usageLimit || null,
        data.perUserLimit || 1,
        data.validFrom || null,
        data.validUntil || null,
      ]
    )
    return this._format(rows[0])
  }

  /**
   * Update a coupon
   */
  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1

    const fieldMap = {
      code: 'code', description: 'description', discountType: 'discount_type',
      discountValue: 'discount_value', minOrderAmount: 'min_order_amount',
      maxDiscount: 'max_discount', usageLimit: 'usage_limit', perUserLimit: 'per_user_limit',
      validFrom: 'valid_from', validUntil: 'valid_until', isActive: 'is_active',
    }

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        const val = jsKey === 'code' ? data[jsKey].toUpperCase() : data[jsKey]
        fields.push(`${dbKey} = $${idx++}`)
        params.push(val)
      }
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE coupons SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, code, description, discount_type, discount_value, min_order_amount,
                 max_discount, usage_limit, used_count, per_user_limit, valid_from, valid_until,
                 is_active, created_at, updated_at`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Delete a coupon
   */
  async delete(id) {
    const result = await query(`DELETE FROM coupons WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id:             row.id,
      code:           row.code,
      description:    row.description,
      discountType:   row.discount_type,
      discountValue:  parseFloat(row.discount_value),
      minOrderAmount: parseFloat(row.min_order_amount),
      maxDiscount:    row.max_discount ? parseFloat(row.max_discount) : null,
      usageLimit:     row.usage_limit,
      usedCount:      row.used_count,
      perUserLimit:   row.per_user_limit,
      validFrom:      row.valid_from,
      validUntil:     row.valid_until,
      isActive:       row.is_active,
      createdAt:      row.created_at,
      updatedAt:      row.updated_at,
    }
  }
}
