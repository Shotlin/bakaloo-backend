import { query, getClient } from '../../config/database.js'

/**
 * Orders repository — all SQL queries for orders + order_items
 */
export class OrdersRepository {
  /**
   * Create an order with order items inside a transaction
   */
  async create(client, orderData, items) {
    const { rows } = await client.query(
      `INSERT INTO orders (
        order_number, user_id, status, items, subtotal, discount_amount,
        delivery_fee, platform_fee, tax_amount, total_amount,
        payment_method, payment_status, coupon_code, delivery_address,
        delivery_notes, estimated_delivery,
        handling_fee, late_night_fee, tip_amount, delivery_instructions, savings_total
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [
        orderData.orderNumber,
        orderData.userId,
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
