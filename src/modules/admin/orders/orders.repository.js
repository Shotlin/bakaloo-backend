import { query, getClient } from '../../../config/database.js'

export class AdminOrdersRepository {
  async findAll({ offset, limit, status, paymentMethod, search, startDate, endDate }) {
    let sql = `
      SELECT o.*, u.name AS customer_name, u.phone AS customer_phone,
             ru.name AS rider_name
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN users ru ON ru.id = o.rider_id
      WHERE 1=1
    `
    const params = []
    let idx = 1

    if (status) { params.push(status); sql += ` AND o.status = $${idx++}` }
    if (paymentMethod) { params.push(paymentMethod); sql += ` AND o.payment_method = $${idx++}` }
    if (startDate) { params.push(startDate); sql += ` AND o.created_at >= $${idx++}` }
    if (endDate) { params.push(endDate); sql += ` AND o.created_at <= $${idx++}` }
    if (search) {
      params.push(`%${search}%`)
      sql += ` AND (o.order_number ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.name ILIKE $${idx})`
      idx++
    }

    const countSql = `SELECT COUNT(*) FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE 1=1` +
      sql.split('WHERE 1=1')[1].replace(/ORDER BY.*$/, '').replace(/LIMIT.*$/, '')
    const countRes = await query(countSql, params)
    const total = parseInt(countRes.rows[0].count)

    params.push(limit, offset)
    sql += ` ORDER BY o.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`

    const { rows } = await query(sql, params)
    return { orders: rows, total }
  }

  async getStatsByStatus() {
    const { rows } = await query(
      `SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status`
    )
    return rows.reduce((acc, r) => { acc[r.status] = r.count; return acc }, {})
  }

  async findById(orderId) {
    const { rows } = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
              ru.name AS rider_name, ru.phone AS rider_phone
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN users ru ON ru.id = o.rider_id
       WHERE o.id = $1`,
      [orderId]
    )
    return rows[0] || null
  }

  async getOrderItems(orderId) {
    const { rows } = await query(
      `SELECT oi.*, p.thumbnail_url, p.net_quantity
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.created_at`,
      [orderId]
    )
    return rows
  }

  async getOrderTimeline(orderId) {
    const { rows } = await query(
      `SELECT osh.*, u.name AS changed_by_name
       FROM order_status_history osh
       LEFT JOIN users u ON u.id = osh.changed_by
       WHERE osh.order_id = $1
       ORDER BY osh.changed_at ASC`,
      [orderId]
    )
    return rows
  }

  async getOrderPayment(orderId) {
    const { rows } = await query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orderId]
    )
    return rows[0] || null
  }

  async getOrderDelivery(orderId) {
    const { rows } = await query(
      'SELECT * FROM delivery_assignments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orderId]
    )
    return rows[0] || null
  }

  async updateStatus(orderId, newStatus, adminId, note) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [order] } = await client.query(
        'SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId]
      )
      if (!order) throw { statusCode: 404, message: 'Order not found' }

      // Only the rider-app delivery-completion flow (delivery.repository.js)
      // was setting delivered_at — this admin-dashboard path never did, so
      // any order an admin marked DELIVERED directly (support/testing) had
      // a permanently NULL delivered_at. The nightly settlement worker
      // filters strictly on delivered_at falling within its date window,
      // so those orders were silently excluded from shop_financials and
      // shop_transactions forever, even though status correctly read
      // DELIVERED everywhere else in the dashboard.
      if (newStatus === 'DELIVERED') {
        await client.query(
          `UPDATE orders SET status = $1, delivered_at = COALESCE(delivered_at, NOW()), updated_at = NOW() WHERE id = $2`,
          [newStatus, orderId]
        )
      } else {
        await client.query(
          'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
          [newStatus, orderId]
        )
      }

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, order.status, newStatus, adminId, note || null]
      )

      await client.query('COMMIT')
      return order.status // return old status for activity log
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /** Plain field update — no status-machine transition involved, unlike updateStatus(). */
  async rescheduleDelivery(orderId, { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel }) {
    const { rows } = await query(
      `UPDATE orders
       SET delivery_mode = 'SCHEDULED',
           scheduled_delivery_at = $1,
           scheduled_slot_start = $1,
           scheduled_slot_end = $2,
           scheduled_slot_label = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, user_id, rider_id, order_number, status,
                 scheduled_slot_start, scheduled_slot_end, scheduled_slot_label`,
      [scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, orderId]
    )
    return rows[0] || null
  }

  async assignRider(orderId, riderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      await client.query(
        `UPDATE delivery_assignments
         SET status = 'CANCELLED',
             cancel_reason = 'Reassigned by admin',
             cancelled_at = NOW(),
             updated_at = NOW()
         WHERE order_id = $1
           AND status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')`,
        [orderId]
      )

      await client.query(
        'UPDATE orders SET rider_id = $1, updated_at = NOW() WHERE id = $2',
        [riderId, orderId]
      )

      // Create a fresh assignment row (no ON CONFLICT dependency on order_id).
      const { rows: [assignment] } = await client.query(
        `INSERT INTO delivery_assignments (order_id, rider_id, status, assigned_at, earnings)
         SELECT $1, $2, 'ASSIGNED', NOW(), COALESCE(NULLIF(o.delivery_fee, 0), 25)
         FROM orders o
         WHERE o.id = $1
         RETURNING id, order_id, rider_id, status, assigned_at`,
        [orderId, riderId]
      )

      await client.query('COMMIT')
      return assignment
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async bulkAssign(assignments) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const results = []
      for (const { orderId, riderId } of assignments) {
        await client.query(
          `UPDATE delivery_assignments
           SET status = 'CANCELLED',
               cancel_reason = 'Reassigned by bulk assign',
               cancelled_at = NOW(),
               updated_at = NOW()
           WHERE order_id = $1
             AND status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')`,
          [orderId]
        )

        await client.query(
          'UPDATE orders SET rider_id = $1, updated_at = NOW() WHERE id = $2',
          [riderId, orderId]
        )

        const { rows: [assignment] } = await client.query(
          `INSERT INTO delivery_assignments (order_id, rider_id, status, assigned_at, earnings)
           SELECT $1, $2, 'ASSIGNED', NOW(), COALESCE(NULLIF(o.delivery_fee, 0), 25)
           FROM orders o
           WHERE o.id = $1
           RETURNING id, order_id, rider_id, status, assigned_at`,
          [orderId, riderId]
        )
        results.push({
          assignmentId: assignment.id,
          orderId,
          riderId,
          status: 'assigned',
        })
      }
      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async createManualOrder({ userId, items, paymentMethod, deliveryAddress, couponCode, adminId }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Calculate totals
      let subtotal = 0
      const orderItems = []
      for (const item of items) {
        const { rows: [product] } = await client.query(
          'SELECT id, name, price, sale_price, stock_quantity, unit FROM products WHERE id = $1 AND is_active = true',
          [item.productId]
        )
        if (!product) throw { statusCode: 400, message: `Product ${item.productId} not found` }
        if (product.stock_quantity < item.quantity) throw { statusCode: 400, message: `${product.name} out of stock` }

        const price = product.sale_price || product.price
        const total = price * item.quantity
        subtotal += total
        orderItems.push({
          product_id: product.id,
          name: product.name,
          price: parseFloat(price),
          quantity: item.quantity,
          unit: product.unit,
          total: parseFloat(total),
        })
      }

      // Generate order number
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`

      const { rows: [order] } = await client.query(
        `INSERT INTO orders (order_number, user_id, status, items, subtotal, total_amount, payment_method, payment_status, delivery_address)
         VALUES ($1, $2, 'CONFIRMED', $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          orderNumber, userId, JSON.stringify(orderItems),
          subtotal, subtotal, paymentMethod || 'MANUAL',
          paymentMethod === 'COD' ? 'PENDING' : 'PAID',
          JSON.stringify(deliveryAddress),
        ]
      )

      // Insert order items
      for (const oi of orderItems) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, name, price, quantity, unit, total)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [order.id, oi.product_id, oi.name, oi.price, oi.quantity, oi.unit, oi.total]
        )
        // Deduct stock
        await client.query(
          'UPDATE products SET stock_quantity = stock_quantity - $1, total_sold = total_sold + $1 WHERE id = $2',
          [oi.quantity, oi.product_id]
        )
      }

      // Log initial status
      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, NULL, 'CONFIRMED', $2, 'Manual order by admin')`,
        [order.id, adminId]
      )

      await client.query('COMMIT')
      return order
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async getOrdersForExport({ status, startDate, endDate }) {
    let sql = `
      SELECT o.order_number, o.status, o.total_amount, o.payment_method, o.payment_status,
             o.created_at, u.name AS customer, u.phone, o.delivery_address->>'city' AS city
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE 1=1
    `
    const params = []
    let idx = 1
    if (status) { params.push(status); sql += ` AND o.status = $${idx++}` }
    if (startDate) { params.push(startDate); sql += ` AND o.created_at >= $${idx++}` }
    if (endDate) { params.push(endDate); sql += ` AND o.created_at <= $${idx++}` }
    sql += ' ORDER BY o.created_at DESC'

    const { rows } = await query(sql, params)
    return rows
  }

  async findUserByPhone(phone) {
    const { rows } = await query('SELECT id, name, phone FROM users WHERE phone = $1', [phone])
    return rows[0] || null
  }
}
