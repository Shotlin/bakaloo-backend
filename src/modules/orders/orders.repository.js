import { query, getClient } from '../../config/database.js'

/**
 * Orders repository — all SQL queries for orders + order_items
 *
 * TODO (R14.7 / multi-vendor task 4.1 follow-up): several legacy reads in
 * this repository still use `SELECT *` / `RETURNING *` (findById, findByUser,
 * findAll, updateStatus, assignRider). These were not touched by task 4.1
 * because that task is scoped to the shops and shop-products repositories.
 * `SELECT *` does already surface the new `auto_assignment_status` column
 * (added by migration 040) so consumers receive it correctly today, but the
 * R14.7 "explicit column list, no SELECT *" rule still applies — converting
 * these is tracked for a dedicated cleanup task. When that conversion lands,
 * the explicit projection MUST include `auto_assignment_status` alongside
 * the existing columns, and `_format()` should expose it on the camelCase
 * payload so the HQ "manual rider required" UI can read it without a second
 * fetch.
 */
export class OrdersRepository {
  /**
   * Create an order with order items inside a transaction
   *
   * In the multi-vendor world every checkout produces one order per shop,
   * so `shopId` is expected on `orderData`. Legacy callers (e.g. tests, demo
   * scripts) that pre-date Migration 033 may omit it; the column is nullable
   * to preserve backward compatibility during the transition.
   */
  async create(client, orderData, items) {
    const { rows } = await client.query(
      `INSERT INTO orders (
        order_number, user_id, shop_id, status, items, subtotal, discount_amount,
        delivery_fee, platform_fee, tax_amount, total_amount,
        payment_method, payment_status, coupon_code, delivery_address,
        delivery_notes, estimated_delivery,
        handling_fee, late_night_fee, tip_amount, delivery_instructions, savings_total
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING id, order_number, user_id, shop_id, rider_id, status, items,
                subtotal, discount_amount, delivery_fee, platform_fee, tax_amount, total_amount,
                payment_method, payment_status, coupon_code, delivery_address, delivery_notes,
                estimated_delivery, delivered_at, proof_photo_url, cancelled_reason,
                handling_fee, late_night_fee, tip_amount, delivery_instructions, savings_total,
                created_at, updated_at`,
      [
        orderData.orderNumber,
        orderData.userId,
        orderData.shopId || null,
        orderData.status || 'PENDING',
        JSON.stringify(orderData.items),
        orderData.subtotal,
        orderData.discountAmount || 0,
        orderData.deliveryFee || 0,
        orderData.platformFee || 0,
        orderData.taxAmount || 0,
        orderData.totalAmount,
        orderData.paymentMethod,
        orderData.paymentStatus || 'PENDING',
        orderData.couponCode || null,
        JSON.stringify(orderData.deliveryAddress),
        orderData.deliveryNotes || null,
        orderData.estimatedDelivery || null,
        orderData.handlingFee || 0,
        orderData.lateNightFee || 0,
        orderData.tipAmount || 0,
        orderData.deliveryInstructions || null,
        orderData.savingsTotal || 0,
      ]
    )

    // Insert denormalized order items
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, price, quantity, unit, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [rows[0].id, item.productId, item.name, item.price, item.quantity, item.unit, item.total]
      )
    }

    return this._format(rows[0])
  }

  /**
   * Update mutable post-checkout extras (tip / handling / late-night /
   * savings / delivery instructions). Used by the multi-vendor checkout
   * flow when a single-shop cart's tip arrives after the per-shop order is
   * already inserted by the OrderSplitter.
   *
   * Only single-shop carts have a well-defined "owner" for tip and similar
   * extras, so this is intentionally a narrow update.
   */
  async updateExtras(orderId, extras = {}) {
    const sets = []
    const params = []
    let idx = 1

    if (Object.prototype.hasOwnProperty.call(extras, 'tipAmount')) {
      sets.push(`tip_amount = $${idx++}`)
      params.push(Number(extras.tipAmount) || 0)
    }
    if (Object.prototype.hasOwnProperty.call(extras, 'handlingFee')) {
      sets.push(`handling_fee = $${idx++}`)
      params.push(Number(extras.handlingFee) || 0)
    }
    if (Object.prototype.hasOwnProperty.call(extras, 'lateNightFee')) {
      sets.push(`late_night_fee = $${idx++}`)
      params.push(Number(extras.lateNightFee) || 0)
    }
    if (Object.prototype.hasOwnProperty.call(extras, 'savingsTotal')) {
      sets.push(`savings_total = $${idx++}`)
      params.push(Number(extras.savingsTotal) || 0)
    }
    if (Object.prototype.hasOwnProperty.call(extras, 'deliveryInstructions')) {
      sets.push(`delivery_instructions = $${idx++}`)
      params.push(extras.deliveryInstructions || null)
    }

    if (sets.length === 0) return null

    sets.push('updated_at = NOW()')
    params.push(orderId)

    const { rows } = await query(
      `UPDATE orders SET ${sets.join(', ')}
       WHERE id = $${idx}
       RETURNING id, order_number, user_id, shop_id, status,
                 handling_fee, late_night_fee, tip_amount,
                 delivery_instructions, savings_total, updated_at`,
      params
    )
    return rows[0] || null
  }

  /**
   * Decrement stock for products in an order (within transaction)
   */
  async decrementStock(client, items) {
    for (const item of items) {
      const { rowCount } = await client.query(
        `UPDATE products SET stock_quantity = stock_quantity - $1, total_sold = total_sold + $1,
                updated_at = NOW()
         WHERE id = $2 AND stock_quantity >= $1`,
        [item.quantity, item.productId]
      )
      if (rowCount === 0) {
        throw new Error(`Insufficient stock for product "${item.name}"`)
      }
    }
  }

  /**
   * Restore stock when an order is cancelled (within transaction)
   */
  async restoreStock(client, items) {
    for (const item of items) {
      await client.query(
        `UPDATE products SET stock_quantity = stock_quantity + $1, total_sold = GREATEST(0, total_sold - $1),
                updated_at = NOW()
         WHERE id = $2`,
        [item.quantity, item.productId]
      )
    }
  }

  /**
   * Find order by ID
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT * FROM orders WHERE id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find order by ID and user
   */
  async findByIdAndUser(id, userId) {
    const { rows } = await query(
      `SELECT o.*, ru.name AS rider_name, ru.phone AS rider_phone
       FROM orders o
       LEFT JOIN users ru ON ru.id = o.rider_id
       WHERE o.id = $1 AND o.user_id = $2`,
      [id, userId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find active order for user (latest non-completed)
   */
  async findActiveByUser(userId) {
    const { rows } = await query(
      `SELECT o.*, ru.name AS rider_name, ru.phone AS rider_phone
       FROM orders o
       LEFT JOIN users ru ON ru.id = o.rider_id
       WHERE o.user_id = $1
         AND o.status IN ('PENDING','CONFIRMED','PREPARING','PACKED','OUT_FOR_DELIVERY')
       ORDER BY o.created_at DESC
       LIMIT 1`,
      [userId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async getStatusHistory(orderId) {
    const { rows } = await query(
      `SELECT id, from_status, to_status, note, changed_at, changed_by
       FROM order_status_history
       WHERE order_id = $1
       ORDER BY changed_at ASC`,
      [orderId]
    )
    return rows
  }

  /**
   * Aggregate DELIVERED orders for a shop within a half-open UTC window
   * `[periodStart, periodEnd)`. Powers the Settlement_Worker daily roll-up
   * (Req 6.2, 6.3, 6.4).
   *
   * SELECT projection (Req 14.7 — explicit columns, no SELECT *):
   *   - total_orders   = COUNT(*)
   *   - gross_revenue  = SUM(total_amount)
   *                      Uses total_amount (customer-paid value) so the
   *                      aggregator surfaces a single number that
   *                      reconciles against payments. The settlement
   *                      service may additionally use SUM(subtotal) via
   *                      the write repository when it needs the
   *                      merchandise-only figure for commission
   *                      computation.
   *   - delivery_costs = SUM(delivery_fee)
   *   - refund_amount  = SUM(payments.refund_amount) over LEFT JOIN
   *                      (refunds live on the payments table, not orders).
   *
   * Index: `idx_orders_shop_id_status_created (shop_id, status,
   * created_at DESC)` narrows the candidate set on (shop_id,
   * status='DELIVERED'); the delivered_at window is filtered after the
   * index lookup.
   *
   * @param {string} shopId
   * @param {Date|string} periodStart - Inclusive (UTC)
   * @param {Date|string} periodEnd   - Exclusive (UTC)
   * @returns {Promise<{
   *   totalOrders:number,
   *   grossRevenue:number,
   *   deliveryCosts:number,
   *   refundAmount:number
   * }>}
   */
  async aggregateDeliveredForShop(shopId, periodStart, periodEnd) {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int                                    AS total_orders,
         COALESCE(SUM(o.total_amount), 0)::numeric(12,2)  AS gross_revenue,
         COALESCE(SUM(o.delivery_fee), 0)::numeric(10,2)  AS delivery_costs,
         COALESCE(SUM(p.refund_amount), 0)::numeric(10,2) AS refund_amount
       FROM orders o
       LEFT JOIN payments p
              ON p.order_id = o.id
             AND p.refund_amount IS NOT NULL
       WHERE o.shop_id = $1
         AND o.status = 'DELIVERED'
         AND o.delivered_at >= $2
         AND o.delivered_at < $3`,
      [shopId, periodStart, periodEnd]
    )
    const r = rows[0] || {}
    return {
      totalOrders: Number(r.total_orders) || 0,
      grossRevenue: Number(r.gross_revenue) || 0,
      deliveryCosts: Number(r.delivery_costs) || 0,
      refundAmount: Number(r.refund_amount) || 0,
    }
  }

  /**
   * List orders for a user (paginated)
   */
  async findByUser(userId, { limit, offset, status }) {
    const conditions = ['user_id = $1']
    const params = [userId]
    let idx = 2

    if (status) {
      conditions.push(`status = $${idx++}`)
      params.push(status)
    }

    const where = conditions.join(' AND ')

    const countResult = await query(
      `SELECT COUNT(*) FROM orders WHERE ${where}`,
      params
    )

    const { rows } = await query(
      `SELECT * FROM orders WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    )

    return {
      orders: rows.map(this._format),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Admin: list all orders (paginated, filterable)
   */
  async findAll({ limit, offset, status, userId }) {
    const conditions = []
    const params = []
    let idx = 1

    if (status) {
      conditions.push(`status = $${idx++}`)
      params.push(status)
    }

    if (userId) {
      conditions.push(`user_id = $${idx++}`)
      params.push(userId)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(*) FROM orders ${where}`,
      params
    )

    const { rows } = await query(
      `SELECT * FROM orders ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    )

    return {
      orders: rows.map(this._format),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Update order status
   */
  async updateStatus(id, status, extra = {}) {
    const sets = ['status = $1', 'updated_at = NOW()']
    const params = [status]
    let idx = 2

    if (extra.cancelledReason) {
      sets.push(`cancelled_reason = $${idx++}`)
      params.push(extra.cancelledReason)
    }
    if (extra.deliveredAt) {
      sets.push(`delivered_at = $${idx++}`)
      params.push(extra.deliveredAt)
    }
    if (extra.paymentStatus) {
      sets.push(`payment_status = $${idx++}`)
      params.push(extra.paymentStatus)
    }

    params.push(id)

    const { rows } = await query(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING *`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Assign a rider to an order
   */
  async assignRider(id, riderId) {
    const { rows } = await query(
      `UPDATE orders SET rider_id = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [riderId, id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Generate order number: GRO-YYYYMMDD-XXX
   */
  async generateOrderNumber() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const pattern = `GRO-${today}-%`

    const { rows } = await query(
      `SELECT COUNT(*) FROM orders WHERE order_number LIKE $1`,
      [pattern]
    )

    const seq = parseInt(rows[0].count, 10) + 1
    return `GRO-${today}-${String(seq).padStart(3, '0')}`
  }

  /**
   * Get order items from order_items table
   */
  async getOrderItems(orderId) {
    const { rows } = await query(
      `SELECT product_id, name, price, quantity, unit, total
       FROM order_items
       WHERE order_id = $1`,
      [orderId]
    )
    return rows
  }

  /**
   * Format snake_case row to camelCase
   */
  _format(row) {
    return {
      id: row.id,
      orderNumber: row.order_number,
      userId: row.user_id,
      shopId: row.shop_id || null,
      riderId: row.rider_id,
      riderName: row.rider_name || null,
      riderPhone: row.rider_phone || null,
      status: row.status,
      items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
      subtotal: parseFloat(row.subtotal),
      discountAmount: parseFloat(row.discount_amount),
      deliveryFee: parseFloat(row.delivery_fee),
      platformFee: parseFloat(row.platform_fee),
      taxAmount: parseFloat(row.tax_amount),
      totalAmount: parseFloat(row.total_amount),
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      couponCode: row.coupon_code,
      deliveryAddress: typeof row.delivery_address === 'string'
        ? JSON.parse(row.delivery_address)
        : row.delivery_address,
      deliveryNotes: row.delivery_notes,
      estimatedDelivery: row.estimated_delivery,
      deliveredAt: row.delivered_at,
      proofPhotoUrl: row.proof_photo_url,
      cancelledReason: row.cancelled_reason,
      handlingFee: parseFloat(row.handling_fee || 0),
      lateNightFee: parseFloat(row.late_night_fee || 0),
      tipAmount: parseFloat(row.tip_amount || 0),
      deliveryInstructions: row.delivery_instructions || null,
      savingsTotal: parseFloat(row.savings_total || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
