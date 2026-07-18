import { query } from '../../config/database.js'

const COLUMNS = `
  id, name, min_cart_amount, reward_type, reward_value, max_discount,
  unlock_coupon_id, message_before, message_after, icon_url, is_active,
  applicable_user_type, applicable_segment_id, stackable_with_coupon,
  priority, cashback_credit_trigger, usage_limit_per_user, created_by,
  created_at, updated_at
`

export class CartMilestonesRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM cart_milestones ORDER BY min_cart_amount ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM cart_milestones WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  /** All active milestones ordered by tier — used to build the full progress ladder. */
  async findAllActive() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM cart_milestones WHERE is_active = true ORDER BY min_cart_amount ASC`
    )
    return rows.map(this._format)
  }

  /**
   * True only once userId has an order that was actually DELIVERED — same
   * check used by FIRST_TIME coupon targeting (coupons.repository.js) and
   * first-time-offers.repository.js. See those for the full rationale on
   * why this checks delivered_at rather than status.
   */
  async hasPriorOrder(userId) {
    const { rows } = await query(
      `SELECT EXISTS(
         SELECT 1 FROM orders WHERE user_id = $1 AND delivered_at IS NOT NULL
       ) AS has_prior`,
      [userId]
    )
    return rows[0].has_prior
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO cart_milestones (
         name, min_cart_amount, reward_type, reward_value, max_discount,
         unlock_coupon_id, message_before, message_after, icon_url,
         applicable_user_type, applicable_segment_id, stackable_with_coupon,
         priority, cashback_credit_trigger, usage_limit_per_user, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${COLUMNS}`,
      [
        data.name,
        data.minCartAmount,
        data.rewardType,
        data.rewardValue ?? null,
        data.maxDiscount ?? null,
        data.unlockCouponId ?? null,
        data.messageBefore ?? null,
        data.messageAfter ?? null,
        data.iconUrl ?? null,
        data.applicableUserType ?? 'ALL',
        data.applicableSegmentId ?? null,
        data.stackableWithCoupon ?? true,
        data.priority ?? 0,
        data.cashbackCreditTrigger ?? 'ORDER_DELIVERED',
        data.usageLimitPerUser ?? null,
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
      minCartAmount: 'min_cart_amount',
      rewardType: 'reward_type',
      rewardValue: 'reward_value',
      maxDiscount: 'max_discount',
      unlockCouponId: 'unlock_coupon_id',
      messageBefore: 'message_before',
      messageAfter: 'message_after',
      iconUrl: 'icon_url',
      isActive: 'is_active',
      applicableUserType: 'applicable_user_type',
      applicableSegmentId: 'applicable_segment_id',
      stackableWithCoupon: 'stackable_with_coupon',
      priority: 'priority',
      cashbackCreditTrigger: 'cashback_credit_trigger',
      usageLimitPerUser: 'usage_limit_per_user',
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
      `UPDATE cart_milestones SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async delete(id) {
    const result = await query(`DELETE FROM cart_milestones WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  /** How many times this user has already redeemed this milestone's reward. */
  async getUserUsageCount(milestoneId, userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM cart_milestone_usages
       WHERE cart_milestone_id = $1 AND user_id = $2`,
      [milestoneId, userId]
    )
    return rows[0].count
  }

  /** Record a redemption — called once per order right after the reward is applied. */
  async recordUsage(milestoneId, userId, orderId) {
    await query(
      `INSERT INTO cart_milestone_usages (cart_milestone_id, user_id, order_id)
       VALUES ($1, $2, $3)`,
      [milestoneId, userId, orderId]
    )
  }

  _format(row) {
    return {
      id: row.id,
      name: row.name,
      minCartAmount: parseFloat(row.min_cart_amount),
      rewardType: row.reward_type,
      rewardValue: row.reward_value != null ? parseFloat(row.reward_value) : null,
      maxDiscount: row.max_discount != null ? parseFloat(row.max_discount) : null,
      unlockCouponId: row.unlock_coupon_id,
      messageBefore: row.message_before,
      messageAfter: row.message_after,
      iconUrl: row.icon_url,
      isActive: row.is_active,
      applicableUserType: row.applicable_user_type,
      applicableSegmentId: row.applicable_segment_id,
      stackableWithCoupon: row.stackable_with_coupon,
      priority: row.priority,
      cashbackCreditTrigger: row.cashback_credit_trigger,
      usageLimitPerUser: row.usage_limit_per_user,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
