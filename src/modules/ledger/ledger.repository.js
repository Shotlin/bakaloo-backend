import { query } from '../../config/database.js'

const LIST_COLUMNS = `
  la.id, la.business_account_id, la.monthly_credit_limit, la.hard_limit,
  la.current_balance, la.billing_day, la.status,
  la.created_at, la.updated_at,
  ba.company_name, ba.gst_number, ba.user_id,
  u.name AS customer_name, u.phone AS customer_phone
`

/**
 * Ledger repository — SQL queries for ledger_accounts + ledger_transactions
 * + ledger_billing_cycles. Balance mutations mirror WalletRepository's
 * SELECT ... FOR UPDATE + guarded-UPDATE idiom (see draw()/repay() below).
 */
export class LedgerRepository {
  async findById(id) {
    const { rows } = await query(
      `SELECT ${LIST_COLUMNS}
         FROM ledger_accounts la
         JOIN business_accounts ba ON ba.id = la.business_account_id
         JOIN users u ON u.id = ba.user_id
        WHERE la.id = $1`,
      [id]
    )
    return rows[0] || null
  }

  async findByBusinessAccountId(businessAccountId) {
    const { rows } = await query(
      `SELECT ${LIST_COLUMNS}
         FROM ledger_accounts la
         JOIN business_accounts ba ON ba.id = la.business_account_id
         JOIN users u ON u.id = ba.user_id
        WHERE la.business_account_id = $1`,
      [businessAccountId]
    )
    return rows[0] || null
  }

  async findByUserId(userId) {
    const { rows } = await query(
      `SELECT ${LIST_COLUMNS}
         FROM ledger_accounts la
         JOIN business_accounts ba ON ba.id = la.business_account_id
         JOIN users u ON u.id = ba.user_id
        WHERE ba.user_id = $1`,
      [userId]
    )
    return rows[0] || null
  }

  async create({ businessAccountId, monthlyCreditLimit, hardLimit, billingDay }) {
    const { rows } = await query(
      `INSERT INTO ledger_accounts
         (business_account_id, monthly_credit_limit, hard_limit, billing_day)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [businessAccountId, monthlyCreditLimit, hardLimit, billingDay]
    )
    return this.findById(rows[0].id)
  }

  async updateLimits(id, { monthlyCreditLimit, hardLimit, billingDay }) {
    const { rows } = await query(
      `UPDATE ledger_accounts
          SET monthly_credit_limit = $2,
              hard_limit = $3,
              billing_day = $4,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [id, monthlyCreditLimit, hardLimit, billingDay]
    )
    if (rows.length === 0) return null
    return this.findById(rows[0].id)
  }

  async setStatus(id, status) {
    const { rows } = await query(
      `UPDATE ledger_accounts SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id, status]
    )
    if (rows.length === 0) return null
    return this.findById(rows[0].id)
  }

  async list({ status, page = 1, limit = 20 } = {}) {
    const conditions = []
    const params = []
    let idx = 1

    if (status) {
      conditions.push(`la.status = $${idx++}`)
      params.push(status)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const offset = (page - 1) * limit

    const countResult = await query(
      `SELECT COUNT(*) FROM ledger_accounts la ${where}`,
      params
    )

    const { rows } = await query(
      `SELECT ${LIST_COLUMNS}
         FROM ledger_accounts la
         JOIN business_accounts ba ON ba.id = la.business_account_id
         JOIN users u ON u.id = ba.user_id
         ${where}
        ORDER BY la.created_at DESC
        LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    )

    return { rows, total: parseInt(countResult.rows[0].count, 10) }
  }

  /**
   * Lock a ledger account row for update within an open transaction.
   */
  async getForUpdate(client, ledgerAccountId) {
    const { rows } = await client.query(
      `SELECT * FROM ledger_accounts WHERE id = $1 FOR UPDATE`,
      [ledgerAccountId]
    )
    return rows[0] || null
  }

  /**
   * Draw against the ledger (increase amount owed) within a transaction.
   * Atomically guarded against hard_limit — the one figure actually
   * enforced (monthly_credit_limit is a soft/billing-only cap; overage
   * past it is allowed and settled at cycle-end). Throws when the draw
   * would breach the hard limit or the account isn't ACTIVE — callers
   * decide how to surface that.
   *
   * @returns {{ account: object, transaction: object }}
   */
  async draw(client, ledgerAccountId, amount, description, { orderId, bulkOrderId } = {}) {
    const { rows: accountRows } = await client.query(
      `UPDATE ledger_accounts
          SET current_balance = current_balance + $1, updated_at = NOW()
        WHERE id = $2
          AND status = 'ACTIVE'
          AND current_balance + $1 <= hard_limit
        RETURNING *`,
      [amount, ledgerAccountId]
    )

    if (accountRows.length === 0) {
      throw new Error('Ledger draw rejected — account inactive or hard limit exceeded')
    }

    const account = accountRows[0]

    const { rows: txRows } = await client.query(
      `INSERT INTO ledger_transactions
         (ledger_account_id, type, amount, description, order_id, bulk_order_id, balance_after)
       VALUES ($1, 'DRAW', $2, $3, $4, $5, $6)
       RETURNING *`,
      [ledgerAccountId, amount, description || 'Ledger draw', orderId || null, bulkOrderId || null, account.current_balance]
    )

    return { account, transaction: txRows[0] }
  }

  /**
   * Record a repayment (decrease amount owed) within a transaction —
   * settling a billing cycle, or an admin adjustment. Guarded so the
   * balance never goes negative (CHECK current_balance >= 0 backstops
   * this too, but the guard avoids the query throwing a raw constraint
   * violation).
   */
  async repay(client, ledgerAccountId, amount, description, { billingCycleId } = {}) {
    const { rows: accountRows } = await client.query(
      `UPDATE ledger_accounts
          SET current_balance = GREATEST(current_balance - $1, 0), updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [amount, ledgerAccountId]
    )

    if (accountRows.length === 0) {
      throw new Error('Ledger account not found')
    }

    const account = accountRows[0]

    const { rows: txRows } = await client.query(
      `INSERT INTO ledger_transactions
         (ledger_account_id, type, amount, description, billing_cycle_id, balance_after)
       VALUES ($1, 'REPAYMENT', $2, $3, $4, $5)
       RETURNING *`,
      [ledgerAccountId, amount, description || 'Ledger repayment', billingCycleId || null, account.current_balance]
    )

    return { account, transaction: txRows[0] }
  }

  async getTransactions(ledgerAccountId, { limit = 20, offset = 0 } = {}) {
    const countResult = await query(
      `SELECT COUNT(*) FROM ledger_transactions WHERE ledger_account_id = $1`,
      [ledgerAccountId]
    )
    const { rows } = await query(
      `SELECT * FROM ledger_transactions
        WHERE ledger_account_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [ledgerAccountId, limit, offset]
    )
    return { transactions: rows, total: parseInt(countResult.rows[0].count, 10) }
  }

  // ── Billing cycles (ledger-billing.worker.js) ──────────────────────

  /**
   * ACTIVE accounts whose billing_day matches the given day-of-month —
   * the daily worker's "who opens a cycle today" scan.
   */
  async findActiveAccountsForBillingDay(day) {
    const { rows } = await query(
      `SELECT * FROM ledger_accounts WHERE status = 'ACTIVE' AND billing_day = $1`,
      [day]
    )
    return rows
  }

  /**
   * Open a new billing cycle, snapshotting the account's current balance
   * as amount_due. Idempotent: the (ledger_account_id, period_start)
   * unique constraint means a re-run of the same day's cron simply no-ops
   * on the second attempt (ON CONFLICT DO NOTHING) instead of erroring.
   *
   * @returns {object|null} the created cycle row, or null if one already
   *   existed for this account+period (already handled — not an error).
   */
  async openCycle({ ledgerAccountId, periodStart, periodEnd, amountDue, overageAmount, dueDate }) {
    const { rows } = await query(
      `INSERT INTO ledger_billing_cycles
         (ledger_account_id, period_start, period_end, amount_due, overage_amount, due_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (ledger_account_id, period_start) DO NOTHING
       RETURNING *`,
      [ledgerAccountId, periodStart, periodEnd, amountDue, overageAmount, dueDate]
    )
    return rows[0] || null
  }

  /**
   * DUE cycles whose due_date has passed — the daily worker's overdue sweep.
   */
  async findDueCyclesPastDueDate(asOfDate) {
    const { rows } = await query(
      `SELECT * FROM ledger_billing_cycles WHERE status = 'DUE' AND due_date < $1`,
      [asOfDate]
    )
    return rows
  }

  async findCycleById(id) {
    const { rows } = await query(`SELECT * FROM ledger_billing_cycles WHERE id = $1`, [id])
    return rows[0] || null
  }

  async getCycleForUpdate(client, cycleId) {
    const { rows } = await client.query(
      `SELECT * FROM ledger_billing_cycles WHERE id = $1 FOR UPDATE`,
      [cycleId]
    )
    return rows[0] || null
  }

  async listCyclesForAccount(ledgerAccountId, { limit = 20, offset = 0 } = {}) {
    const countResult = await query(
      `SELECT COUNT(*) FROM ledger_billing_cycles WHERE ledger_account_id = $1`,
      [ledgerAccountId]
    )
    const { rows } = await query(
      `SELECT * FROM ledger_billing_cycles
        WHERE ledger_account_id = $1
        ORDER BY period_start DESC
        LIMIT $2 OFFSET $3`,
      [ledgerAccountId, limit, offset]
    )
    return { cycles: rows, total: parseInt(countResult.rows[0].count, 10) }
  }

  /**
   * DUE/OVERDUE cycles for an account — used to decide whether an account
   * can be reactivated after a payment settles its outstanding cycle(s).
   * Takes an explicit transaction client (not the top-level `query`)
   * because its only caller runs this check in the same transaction as
   * the payment that just (potentially) cleared the last unpaid cycle —
   * reading through the autocommit pool here would still see the
   * pre-transaction, uncommitted state.
   */
  async findUnpaidCyclesForAccount(client, ledgerAccountId) {
    const { rows } = await client.query(
      `SELECT * FROM ledger_billing_cycles
        WHERE ledger_account_id = $1 AND status IN ('DUE', 'OVERDUE')`,
      [ledgerAccountId]
    )
    return rows
  }

  /**
   * Most recent cycle for an account (by period_start) — used to compute
   * the next cycle's period_start (the day after the prior cycle's
   * period_end), so consecutive cycles never gap or overlap.
   */
  async findLatestCycleForAccount(ledgerAccountId) {
    const { rows } = await query(
      `SELECT * FROM ledger_billing_cycles
        WHERE ledger_account_id = $1
        ORDER BY period_start DESC
        LIMIT 1`,
      [ledgerAccountId]
    )
    return rows[0] || null
  }

  async markCycleOverdue(client, cycleId) {
    const { rows } = await client.query(
      `UPDATE ledger_billing_cycles SET status = 'OVERDUE', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [cycleId]
    )
    return rows[0] || null
  }

  async markCyclePaid(client, cycleId, { amountPaid, paymentReference } = {}) {
    const { rows } = await client.query(
      `UPDATE ledger_billing_cycles
          SET status = 'PAID', amount_paid = $2, payment_reference = $3,
              paid_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [cycleId, amountPaid, paymentReference || null]
    )
    return rows[0] || null
  }
}
