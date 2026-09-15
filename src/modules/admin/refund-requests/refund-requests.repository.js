import { query } from '../../../config/database.js'

export class AdminRefundRequestsRepository {
  async findAll({ offset, limit, status, search, startDate, endDate }) {
    // Built once and reused verbatim in both the row query and the count
    // query below — see orders.repository.js's findAll() for why
    // reconstructing the count query's WHERE clause via string-splitting
    // the row query's SQL on a 'WHERE 1=1' marker is unsafe (a comment
    // elsewhere quoting that same marker string silently broke it there).
    let whereClause = ' WHERE 1=1'
    const params = []
    let idx = 1

    if (status) { params.push(status); whereClause += ` AND rr.status = $${idx++}` }
    if (startDate) { params.push(startDate); whereClause += ` AND rr.created_at >= $${idx++}` }
    if (endDate) { params.push(endDate); whereClause += ` AND rr.created_at <= $${idx++}` }
    if (search) {
      params.push(`%${search}%`)
      whereClause += ` AND (o.order_number ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.name ILIKE $${idx})`
      idx++
    }

    const countSql = `
      SELECT COUNT(*) FROM refund_requests rr
      JOIN orders o ON o.id = rr.order_id
      JOIN users u ON u.id = rr.user_id
      ${whereClause}
    `
    const countRes = await query(countSql, params)
    const total = parseInt(countRes.rows[0].count)

    const sql = `
      SELECT rr.*, o.order_number, o.total_amount, o.wallet_amount_used,
             u.name AS customer_name, u.phone AS customer_phone
      FROM refund_requests rr
      JOIN orders o ON o.id = rr.order_id
      JOIN users u ON u.id = rr.user_id
      ${whereClause}
      ORDER BY rr.created_at DESC LIMIT $${idx++} OFFSET $${idx++}
    `
    const rowParams = [...params, limit, offset]

    const { rows } = await query(sql, rowParams)
    return { requests: rows, total }
  }

  async findById(id) {
    const { rows } = await query(
      `SELECT rr.*, o.order_number, o.total_amount, o.wallet_amount_used, o.payment_method,
              u.name AS customer_name, u.phone AS customer_phone
       FROM refund_requests rr
       JOIN orders o ON o.id = rr.order_id
       JOIN users u ON u.id = rr.user_id
       WHERE rr.id = $1`,
      [id]
    )
    return rows[0] || null
  }

  async updateStatus(id, { status, adminNote, adminId, refundAmount, refundTo }) {
    const { rows } = await query(
      `UPDATE refund_requests
       SET status = $1, admin_note = $2, processed_by = $3, processed_at = NOW(),
           refund_amount = $4, refund_to = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [status, adminNote || null, adminId, refundAmount ?? null, refundTo || null, id]
    )
    return rows[0]
  }
}
