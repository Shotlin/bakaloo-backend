import { query } from '../../config/database.js'

/**
 * Cashback repository — a single generic ledger for every cashback source
 * (coupon / first-time-offer / cart-milestone-later). See migration 068.
 */
export class CashbackRepository {
  /**
   * Create a PENDING cashback_transactions row. Accepts an optional
   * transactional client so callers can create it inside the same
   * transaction as order creation (atomic with the order row existing).
   */
  async createPending(
    { orderId, userId, sourceType, sourceId, amount, creditTrigger },
    client = null
  ) {
    const runner = client || { query }
    const { rows } = await runner.query(
      `INSERT INTO cashback_transactions
         (source_type, source_id, order_id, user_id, amount, credit_trigger, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
       RETURNING *`,
      [sourceType, sourceId ?? null, orderId, userId, amount, creditTrigger]
    )
    return this._format(rows[0])
  }

  /** PENDING rows for an order whose configured trigger matches the given event. */
  async findPendingByOrderAndTrigger(orderId, creditTrigger) {
    const { rows } = await query(
      `SELECT * FROM cashback_transactions
       WHERE order_id = $1 AND status = 'PENDING' AND credit_trigger = $2`,
      [orderId, creditTrigger]
    )
    return rows.map((r) => this._format(r))
  }

  /** All non-cancelled rows for an order (used when cancelling/refunding). */
  async findActiveByOrder(orderId) {
    const { rows } = await query(
      `SELECT * FROM cashback_transactions
       WHERE order_id = $1 AND status IN ('PENDING', 'CREDITED')`,
      [orderId]
    )
    return rows.map((r) => this._format(r))
  }

  async markCredited(id, walletTransactionId) {
    const { rows } = await query(
      `UPDATE cashback_transactions
       SET status = 'CREDITED', wallet_transaction_id = $2, credited_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, walletTransactionId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async markCancelled(id) {
    const { rows } = await query(
      `UPDATE cashback_transactions
       SET status = 'CANCELLED', cancelled_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /** Paginated ledger for the admin cashback/wallet-history view. */
  async findAll({ limit, offset, status, sourceType }) {
    const clauses = []
    const params = []
    let idx = 1
    if (status) {
      clauses.push(`ct.status = $${idx++}`)
      params.push(status)
    }
    if (sourceType) {
      clauses.push(`ct.source_type = $${idx++}`)
      params.push(sourceType)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

    const { rows } = await query(
      `SELECT ct.*, u.name AS user_name, u.phone AS user_phone, o.order_number
       FROM cashback_transactions ct
       INNER JOIN users u ON u.id = ct.user_id
       INNER JOIN orders o ON o.id = ct.order_id
       ${where}
       ORDER BY ct.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )
    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM cashback_transactions ct ${where}`,
      params
    )
    return {
      data: rows.map((r) => ({
        ...this._format(r),
        userName: r.user_name,
        userPhone: r.user_phone,
        orderNumber: r.order_number,
      })),
      total: countRows[0].total,
    }
  }

  _format(row) {
    return {
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      orderId: row.order_id,
      userId: row.user_id,
      amount: parseFloat(row.amount),
      creditTrigger: row.credit_trigger,
      status: row.status,
      walletTransactionId: row.wallet_transaction_id,
      createdAt: row.created_at,
      creditedAt: row.credited_at,
      cancelledAt: row.cancelled_at,
    }
  }
}
