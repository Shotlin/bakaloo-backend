import { query } from '../../config/database.js'

/**
 * Business Accounts repository — all SQL for business_accounts and its
 * audit trail. Shared by the customer-facing service (apply/me/toggle) and
 * the admin service (list/approve/reject) — one source of truth for the
 * table's SQL rather than two independent copies.
 *
 * Migration reference: src/database/migrations/120_business_accounts.sql
 */
export class BusinessAccountsRepository {
  static SELECT_COLUMNS = `
    id, user_id, company_name, gst_number, gst_document_url,
    status, b2b_enabled, rejection_reason,
    submitted_at, reviewed_by, reviewed_at,
    created_at, updated_at
  `

  async findByUserId(userId) {
    const { rows } = await query(
      `SELECT ${BusinessAccountsRepository.SELECT_COLUMNS}
         FROM business_accounts
        WHERE user_id = $1`,
      [userId]
    )
    return rows[0] || null
  }

  async findById(id) {
    const { rows } = await query(
      `SELECT ${BusinessAccountsRepository.SELECT_COLUMNS}
         FROM business_accounts
        WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  async create({ userId, companyName, gstNumber, gstDocumentUrl = null }) {
    const { rows } = await query(
      `INSERT INTO business_accounts (user_id, company_name, gst_number, gst_document_url)
       VALUES ($1, $2, $3, $4)
       RETURNING ${BusinessAccountsRepository.SELECT_COLUMNS}`,
      [userId, companyName, gstNumber, gstDocumentUrl]
    )
    return rows[0]
  }

  /** Resubmission after a REJECTED status — resets status back to PENDING. */
  async resubmit(id, { companyName, gstNumber, gstDocumentUrl = null }) {
    const { rows } = await query(
      `UPDATE business_accounts
          SET company_name = $1, gst_number = $2, gst_document_url = $3,
              status = 'PENDING', rejection_reason = NULL,
              reviewed_by = NULL, reviewed_at = NULL,
              submitted_at = NOW(), updated_at = NOW()
        WHERE id = $4
        RETURNING ${BusinessAccountsRepository.SELECT_COLUMNS}`,
      [companyName, gstNumber, gstDocumentUrl, id]
    )
    return rows[0] || null
  }

  async setEnabled(userId, enabled) {
    const { rows } = await query(
      `UPDATE business_accounts
          SET b2b_enabled = $1, updated_at = NOW()
        WHERE user_id = $2 AND status = 'APPROVED'
        RETURNING ${BusinessAccountsRepository.SELECT_COLUMNS}`,
      [enabled, userId]
    )
    return rows[0] || null
  }

  async list({ status = null, page = 1, limit = 20 } = {}) {
    const conditions = []
    const params = []
    if (status) {
      params.push(status)
      conditions.push(`ba.status = $${params.length}`)
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM business_accounts ba ${whereClause}`,
      params
    )
    const total = countRows[0]?.total || 0

    const offset = (page - 1) * limit
    params.push(limit, offset)
    const { rows } = await query(
      `SELECT ba.id, ba.user_id, ba.company_name, ba.gst_number, ba.gst_document_url,
              ba.status, ba.b2b_enabled, ba.rejection_reason,
              ba.submitted_at, ba.reviewed_by, ba.reviewed_at,
              ba.created_at, ba.updated_at,
              u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email
         FROM business_accounts ba
         JOIN users u ON u.id = ba.user_id
         ${whereClause}
        ORDER BY ba.submitted_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    return { rows, total }
  }

  /**
   * Transition status + write the audit row in one call. `client` is
   * optional — pass one to run inside a caller-managed transaction,
   * otherwise this runs as two independent statements against the pool.
   */
  async transitionStatus(
    id,
    { newStatus, reviewerId, comments = null, action, rejectionReason = null },
    client = null
  ) {
    const runner = client || { query }
    const current = await runner.query(
      `SELECT status FROM business_accounts WHERE id = $1 FOR UPDATE`,
      [id]
    )
    const previousStatus = current.rows[0]?.status
    if (!previousStatus) return null

    const { rows } = await runner.query(
      `UPDATE business_accounts
          SET status = $1, reviewed_by = $2, reviewed_at = NOW(),
              rejection_reason = $3, updated_at = NOW()
        WHERE id = $4
        RETURNING ${BusinessAccountsRepository.SELECT_COLUMNS}`,
      [newStatus, reviewerId, rejectionReason, id]
    )

    await runner.query(
      `INSERT INTO business_account_reviews
         (business_account_id, reviewer_id, action, previous_status, new_status, comments)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, reviewerId, action, previousStatus, newStatus, comments]
    )

    return rows[0] || null
  }
}
