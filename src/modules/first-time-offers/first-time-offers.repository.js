import { query } from '../../config/database.js'

const COLUMNS = `
  id, name, min_order_amount, reward_type, reward_value, max_discount,
  unlock_coupon_id, start_at, end_at, is_active, auto_apply,
  payment_method_scope, cashback_credit_trigger, created_by,
  created_at, updated_at
`

export class FirstTimeOffersRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM first_time_offers ORDER BY min_order_amount ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM first_time_offers WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Best-fit active offer for a cart total — the highest min_order_amount
   * the cart still satisfies (your 3 examples read as a graduated ladder:
   * ₹299 → free delivery, ₹499 → ₹20 cashback, ₹999 → ₹100 cashback — the
   * bigger the order, the better the reward the customer unlocks).
   */
  async findBestFitActive(cartTotal, { onlinePayment } = {}) {
    const clauses = [
      'is_active = true',
      '(start_at IS NULL OR start_at <= NOW())',
      '(end_at IS NULL OR end_at >= NOW())',
      'min_order_amount <= $1',
    ]
    const params = [cartTotal]
    if (onlinePayment === false) {
      // COD checkout — exclude offers scoped to online payment only.
      clauses.push(`payment_method_scope != 'ONLINE_ONLY'`)
    }
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM first_time_offers
       WHERE ${clauses.join(' AND ')}
       ORDER BY min_order_amount DESC
       LIMIT 1`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /** Same first-order check used by FIRST_TIME coupon targeting (coupons.repository.js). */
  async hasPriorOrder(userId) {
    const { rows } = await query(
      `SELECT EXISTS(
         SELECT 1 FROM orders WHERE user_id = $1 AND status != 'CANCELLED'
       ) AS has_prior`,
      [userId]
    )
    return rows[0].has_prior
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO first_time_offers (
         name, min_order_amount, reward_type, reward_value, max_discount,
         unlock_coupon_id, start_at, end_at, auto_apply,
         payment_method_scope, cashback_credit_trigger, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${COLUMNS}`,
      [
        data.name,
        data.minOrderAmount ?? 0,
        data.rewardType,
        data.rewardValue ?? null,
        data.maxDiscount ?? null,
        data.unlockCouponId ?? null,
        data.startAt ?? null,
        data.endAt ?? null,
        data.autoApply ?? true,
        data.paymentMethodScope ?? 'ALL',
        data.cashbackCreditTrigger ?? 'ORDER_DELIVERED',
        data.createdBy ?? null,
      ]
    )
    return this._format(rows[0])
  }

  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      name: 'name',
      minOrderAmount: 'min_order_amount',
      rewardType: 'reward_type',
      rewardValue: 'reward_value',
      maxDiscount: 'max_discount',
      unlockCouponId: 'unlock_coupon_id',
      startAt: 'start_at',
      endAt: 'end_at',
      isActive: 'is_active',
      autoApply: 'auto_apply',
      paymentMethodScope: 'payment_method_scope',
      cashbackCreditTrigger: 'cashback_credit_trigger',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findById(id)
    fields.push(`updated_at = NOW()`)
    params.push(id)
    const { rows } = await query(
      `UPDATE first_time_offers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async delete(id) {
    const result = await query(`DELETE FROM first_time_offers WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id: row.id,
      name: row.name,
      minOrderAmount: parseFloat(row.min_order_amount),
      rewardType: row.reward_type,
      rewardValue: row.reward_value != null ? parseFloat(row.reward_value) : null,
      maxDiscount: row.max_discount != null ? parseFloat(row.max_discount) : null,
      unlockCouponId: row.unlock_coupon_id,
      startAt: row.start_at,
      endAt: row.end_at,
      isActive: row.is_active,
      autoApply: row.auto_apply,
      paymentMethodScope: row.payment_method_scope,
      cashbackCreditTrigger: row.cashback_credit_trigger,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
