import { query } from '../../config/database.js'

/**
 * Payment offers repository — CRUD for payment_offers table
 */
export class PaymentOffersRepository {
  async getActive() {
    const { rows } = await query(
      `SELECT *
       FROM payment_offers
       WHERE is_active = true
         AND (valid_until IS NULL OR valid_until > NOW())
       ORDER BY created_at DESC`
    )
    return rows
  }

  async getAll() {
    const { rows } = await query(
      `SELECT *
       FROM payment_offers
       ORDER BY created_at DESC`
    )
    return rows
  }

  async getById(id) {
    const { rows } = await query(
      `SELECT *
       FROM payment_offers
       WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO payment_offers
       (title, description, provider, icon_url, cashback_amount, cashback_percent,
        min_order_amount, max_cashback, lock_threshold, is_active, valid_from, valid_until,
        cashback_credit_trigger, usage_limit_per_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, true), COALESCE($11, NOW()), $12,
               COALESCE($13, 'ORDER_DELIVERED'), $14)
       RETURNING *`,
      [
        data.title,
        data.description,
        data.provider,
        data.icon_url,
        data.cashback_amount,
        data.cashback_percent,
        data.min_order_amount,
        data.max_cashback,
        data.lock_threshold,
        data.is_active,
        data.valid_from,
        data.valid_until,
        data.cashback_credit_trigger,
        data.usage_limit_per_user,
      ]
    )
    return rows[0] || null
  }

  async update(id, data) {
    const { rows } = await query(
      `UPDATE payment_offers
       SET title = $1,
           description = $2,
           provider = $3,
           icon_url = $4,
           cashback_amount = $5,
           cashback_percent = $6,
           min_order_amount = $7,
           max_cashback = $8,
           lock_threshold = $9,
           is_active = $10,
           valid_from = $11,
           valid_until = $12,
           cashback_credit_trigger = $13,
           usage_limit_per_user = $14,
           updated_at = NOW()
       WHERE id = $15
       RETURNING *`,
      [
        data.title,
        data.description,
        data.provider,
        data.icon_url,
        data.cashback_amount,
        data.cashback_percent,
        data.min_order_amount,
        data.max_cashback,
        data.lock_threshold,
        data.is_active,
        data.valid_from,
        data.valid_until,
        data.cashback_credit_trigger,
        data.usage_limit_per_user,
        id,
      ]
    )
    return rows[0] || null
  }

  async delete(id) {
    const { rows } = await query(
      `DELETE FROM payment_offers
       WHERE id = $1
       RETURNING id`,
      [id]
    )
    return rows[0] || null
  }

  /** How many times this user has already redeemed this offer. */
  async getUserUsageCount(offerId, userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM payment_offer_usages
       WHERE payment_offer_id = $1 AND user_id = $2`,
      [offerId, userId]
    )
    return rows[0].count
  }

  /** Record a redemption — called once per order right after the cashback row is created. */
  async recordUsage(offerId, userId, orderId) {
    await query(
      `INSERT INTO payment_offer_usages (payment_offer_id, user_id, order_id)
       VALUES ($1, $2, $3)`,
      [offerId, userId, orderId]
    )
  }
}
