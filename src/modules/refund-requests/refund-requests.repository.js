import { query } from '../../config/database.js'

export class RefundRequestsRepository {
  async findPendingByOrder(orderId) {
    const { rows } = await query(
      `SELECT id FROM refund_requests WHERE order_id = $1 AND status = 'PENDING'`,
      [orderId]
    )
    return rows[0] || null
  }

  /** Validates every requested productId actually belongs to this order's item snapshot, same idiom as reviews.repository.js#checkUserOrder. */
  async getMatchingOrderItems(orderId, productIds) {
    const { rows } = await query(
      `SELECT item->>'productId' AS "productId", item->>'name' AS name,
              (item->>'quantity')::int AS quantity, (item->>'total')::numeric AS total
       FROM orders o, jsonb_array_elements(o.items) AS item
       WHERE o.id = $1 AND item->>'productId' = ANY($2::text[])`,
      [orderId, productIds]
    )
    return rows
  }

  async create(userId, { orderId, itemScope, items, description }) {
    const { rows } = await query(
      `INSERT INTO refund_requests (order_id, user_id, item_scope, items, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [orderId, userId, itemScope, items ? JSON.stringify(items) : null, description]
    )
    return rows[0]
  }

  async findByIdAndUser(id, userId) {
    const { rows } = await query(
      `SELECT * FROM refund_requests WHERE id = $1 AND user_id = $2`,
      [id, userId]
    )
    return rows[0] || null
  }

  async getUserRequests(userId, { offset, limit }) {
    const [countResult, result] = await Promise.all([
      query('SELECT COUNT(*) FROM refund_requests WHERE user_id = $1', [userId]),
      query(
        `SELECT rr.*, o.order_number
         FROM refund_requests rr
         JOIN orders o ON o.id = rr.order_id
         WHERE rr.user_id = $1
         ORDER BY rr.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
    ])
    const total = parseInt(countResult.rows[0].count)
    return {
      requests: result.rows,
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }
}
