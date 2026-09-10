import { getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { orderQueue } from '../../config/bullmq.js'
import { logAdminActivity } from '../../utils/activityLogger.js'
import { BusinessAccountsRepository } from '../business-accounts/business-accounts.repository.js'
import { OrdersRepository } from '../orders/orders.repository.js'
import { LedgerRepository } from './ledger.repository.js'
import { nextLedgerCycleState } from './ledger-cycle-state-machine.js'

const BILLING_GRACE_DAYS = 7
const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

function toDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function addDays(d, days) {
  const copy = new Date(d)
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

/**
 * Ledger service — B2B credit line, distinct from the customer wallet.
 * Admin creates/configures the ledger once a business account is
 * APPROVED; the customer only ever reads their own balance/transactions
 * here. draw()/repay() are transaction-scoped primitives for the
 * bulk-orders/orders checkout integration (a later phase) — they open
 * their own short transaction when called standalone (e.g. an admin
 * manual adjustment) but accept an existing `client` so a caller that's
 * already mid-transaction (order placement) can fold the draw into it.
 */
export class LedgerService {
  constructor(repository = new LedgerRepository(), businessAccountsRepository = new BusinessAccountsRepository(), deps = {}) {
    this.repo = repository
    this.businessAccountsRepo = businessAccountsRepository
    // Only needed by payFromLedger() below — kept optional/injectable so
    // the constructor stays cheap for every other caller (bulk-orders,
    // admin/customer ledger routes) that never touches this path.
    this.ordersRepo = deps.ordersRepository || new OrdersRepository()
  }

  async getMine(userId) {
    return this.repo.findByUserId(userId)
  }

  async getMyTransactions(userId, { page = 1, limit = 20 } = {}) {
    const account = await this.repo.findByUserId(userId)
    if (!account) throw { statusCode: 404, message: 'No ledger account found' }

    const offset = (page - 1) * limit
    const { transactions, total } = await this.repo.getTransactions(account.id, { limit, offset })
    return {
      transactions,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  async findAll(filters) {
    const { rows, total } = await this.repo.list(filters)
    return {
      accounts: rows,
      pagination: {
        page: filters.page || 1,
        limit: filters.limit || 20,
        total,
        totalPages: Math.ceil(total / (filters.limit || 20)),
      },
    }
  }

  async findById(id) {
    const account = await this.repo.findById(id)
    if (!account) throw { statusCode: 404, message: 'Ledger account not found' }
    return account
  }

  /**
   * Admin: set up a ledger for an APPROVED business account. One ledger
   * per business account (business_account_id UNIQUE) — throws if one
   * already exists; use updateLimits() to change an existing ledger.
   */
  async setup(businessAccountId, { monthlyCreditLimit, hardLimit, billingDay }, adminId, ip) {
    const businessAccount = await this.businessAccountsRepo.findById(businessAccountId)
    if (!businessAccount) throw { statusCode: 404, message: 'Business account not found' }
    if (businessAccount.status !== 'APPROVED') {
      throw { statusCode: 400, message: 'Business account must be APPROVED before a ledger can be set up' }
    }

    const existing = await this.repo.findByBusinessAccountId(businessAccountId)
    if (existing) throw { statusCode: 400, message: 'Ledger already exists for this business account' }

    const effectiveHardLimit = hardLimit != null ? hardLimit : monthlyCreditLimit
    if (effectiveHardLimit < monthlyCreditLimit) {
      throw { statusCode: 400, message: 'hardLimit cannot be less than monthlyCreditLimit' }
    }

    const account = await this.repo.create({
      businessAccountId,
      monthlyCreditLimit,
      hardLimit: effectiveHardLimit,
      billingDay: billingDay || 1,
    })

    logAdminActivity(
      adminId,
      `Set up B2B ledger for ${businessAccount.company_name} (limit ₹${monthlyCreditLimit}, hard limit ₹${effectiveHardLimit})`,
      'ledger_account', account.id, null,
      { monthlyCreditLimit, hardLimit: effectiveHardLimit, billingDay: billingDay || 1 },
      ip
    )

    return account
  }

  async updateLimits(id, { monthlyCreditLimit, hardLimit, billingDay }, adminId, ip) {
    const existing = await this.repo.findById(id)
    if (!existing) throw { statusCode: 404, message: 'Ledger account not found' }

    const nextLimit = monthlyCreditLimit != null ? monthlyCreditLimit : existing.monthly_credit_limit
    const nextHardLimit = hardLimit != null ? hardLimit : existing.hard_limit
    const nextBillingDay = billingDay != null ? billingDay : existing.billing_day

    if (nextHardLimit < nextLimit) {
      throw { statusCode: 400, message: 'hardLimit cannot be less than monthlyCreditLimit' }
    }

    const updated = await this.repo.updateLimits(id, {
      monthlyCreditLimit: nextLimit,
      hardLimit: nextHardLimit,
      billingDay: nextBillingDay,
    })

    logAdminActivity(
      adminId,
      `Updated B2B ledger limits for ${existing.company_name}`,
      'ledger_account', id,
      { monthlyCreditLimit: existing.monthly_credit_limit, hardLimit: existing.hard_limit, billingDay: existing.billing_day },
      { monthlyCreditLimit: nextLimit, hardLimit: nextHardLimit, billingDay: nextBillingDay },
      ip
    )

    return updated
  }

  async setStatus(id, status, adminId, ip) {
    const existing = await this.repo.findById(id)
    if (!existing) throw { statusCode: 404, message: 'Ledger account not found' }

    const updated = await this.repo.setStatus(id, status)

    logAdminActivity(
      adminId,
      `Set B2B ledger status to ${status} for ${existing.company_name}`,
      'ledger_account', id,
      { status: existing.status }, { status },
      ip
    )

    return updated
  }

  /**
   * Draw against a ledger account by user id — used by checkout
   * integrations (bulk-orders/orders, a later phase). Opens its own
   * transaction when no `client` is supplied.
   *
   * @returns {{ account: object, transaction: object }}
   */
  async drawForUser(userId, amount, description, { orderId, bulkOrderId, client } = {}) {
    const account = await this.repo.findByUserId(userId)
    if (!account) throw { statusCode: 404, message: 'No ledger account found for this user' }

    if (client) {
      const locked = await this.repo.getForUpdate(client, account.id)
      if (!locked) throw { statusCode: 404, message: 'Ledger account not found' }
      return this.repo.draw(client, account.id, amount, description, { orderId, bulkOrderId })
    }

    const ownClient = await getClient()
    try {
      await ownClient.query('BEGIN')
      await this.repo.getForUpdate(ownClient, account.id)
      const result = await this.repo.draw(ownClient, account.id, amount, description, { orderId, bulkOrderId })
      await ownClient.query('COMMIT')
      return result
    } catch (err) {
      await ownClient.query('ROLLBACK')
      throw err
    } finally {
      ownClient.release()
    }
  }

  /**
   * Admin manual repayment/adjustment against a ledger account (e.g.
   * recording an offline bank transfer settlement outside the automated
   * billing-cycle flow).
   */
  async adminRepay(id, amount, description, adminId, ip) {
    const existing = await this.repo.findById(id)
    if (!existing) throw { statusCode: 404, message: 'Ledger account not found' }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await this.repo.getForUpdate(client, id)
      const result = await this.repo.repay(client, id, amount, description)
      await client.query('COMMIT')

      logAdminActivity(
        adminId,
        `Recorded ₹${amount} repayment for ${existing.company_name}'s B2B ledger`,
        'ledger_account', id,
        { balance: existing.current_balance }, { balance: result.account.current_balance },
        ip
      )

      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async getMyCycles(userId, { page = 1, limit = 20 } = {}) {
    const account = await this.repo.findByUserId(userId)
    if (!account) throw { statusCode: 404, message: 'No ledger account found' }

    const offset = (page - 1) * limit
    const { cycles, total } = await this.repo.listCyclesForAccount(account.id, { limit, offset })
    return {
      cycles,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  async getCycles(ledgerAccountId, { page = 1, limit = 20 } = {}) {
    const account = await this.repo.findById(ledgerAccountId)
    if (!account) throw { statusCode: 404, message: 'Ledger account not found' }

    const offset = (page - 1) * limit
    const { cycles, total } = await this.repo.listCyclesForAccount(ledgerAccountId, { limit, offset })
    return {
      cycles,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  /**
   * Daily worker entry point (src/workers/ledger-billing.worker.js):
   *   1. Opens a new billing cycle for every ACTIVE account whose
   *      billing_day matches `asOf`'s day-of-month and that currently
   *      owes something (a zero balance needs no statement).
   *   2. Sweeps DUE cycles whose due_date has passed to OVERDUE and
   *      suspends the account — draw()'s `WHERE status='ACTIVE'` guard
   *      then naturally blocks further draws until the admin settles it
   *      via markCyclePaid(), which reactivates the account.
   *
   * Idempotent on both phases: openCycle() no-ops via the (account,
   * period_start) unique constraint on a duplicate run, and the overdue
   * sweep re-locks + re-checks each cycle's status before transitioning
   * it, so a same-day re-run (or a cycle paid moments before the sweep
   * runs) never double-processes a row.
   */
  async runDailyBillingCycle(asOf = new Date()) {
    const today = toDateOnly(asOf)
    const day = today.getUTCDate()

    let opened = 0
    let skippedNoBalance = 0
    let skippedAlreadyOpen = 0

    const accounts = await this.repo.findActiveAccountsForBillingDay(day)
    for (const account of accounts) {
      const balance = parseFloat(account.current_balance)
      if (!(balance > 0)) {
        skippedNoBalance++
        continue
      }

      const latestCycle = await this.repo.findLatestCycleForAccount(account.id)
      const periodStart = latestCycle
        ? addDays(toDateOnly(new Date(latestCycle.period_end)), 1)
        : toDateOnly(new Date(account.created_at))
      const periodEnd = addDays(today, -1)

      if (periodStart > periodEnd) {
        // Account was created today, or a cycle was already opened for
        // today's would-be period — nothing accrued yet to bill.
        skippedAlreadyOpen++
        continue
      }

      const monthlyCreditLimit = parseFloat(account.monthly_credit_limit)
      const overageAmount = Math.max(0, balance - monthlyCreditLimit)
      const dueDate = addDays(today, BILLING_GRACE_DAYS)

      const cycle = await this.repo.openCycle({
        ledgerAccountId: account.id,
        periodStart,
        periodEnd,
        amountDue: balance,
        overageAmount,
        dueDate,
      })

      if (cycle) opened++
      else skippedAlreadyOpen++
    }

    let overdueSwept = 0
    const expiredCycles = await this.repo.findDueCyclesPastDueDate(today)
    for (const cycle of expiredCycles) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        const locked = await this.repo.getCycleForUpdate(client, cycle.id)
        const nextState = locked ? nextLedgerCycleState(locked.status, 'EXPIRE') : null

        if (!nextState) {
          // Already settled (e.g. paid moments before this sweep ran) —
          // nothing to do.
          await client.query('ROLLBACK')
          continue
        }

        await this.repo.markCycleOverdue(client, cycle.id)
        await client.query(
          `UPDATE ledger_accounts SET status = 'SUSPENDED', updated_at = NOW()
            WHERE id = $1 AND status = 'ACTIVE'`,
          [cycle.ledger_account_id]
        )
        await client.query('COMMIT')
        overdueSwept++
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    }

    return { opened, skippedNoBalance, skippedAlreadyOpen, overdueSwept }
  }

  /**
   * Admin: mark a billing cycle as paid — settles the ledger balance by
   * the paid amount (defaulting to the cycle's full amount_due) and
   * reactivates the account once no other cycle is left outstanding.
   */
  async markCyclePaid(cycleId, { amountPaid, paymentReference } = {}, adminId, ip) {
    const cycle = await this.repo.findCycleById(cycleId)
    if (!cycle) throw { statusCode: 404, message: 'Billing cycle not found' }

    const nextState = nextLedgerCycleState(cycle.status, 'PAY')
    if (!nextState) {
      throw { statusCode: 400, message: `Cannot mark a cycle that is already ${cycle.status} as paid` }
    }

    const settleAmount = amountPaid != null ? amountPaid : parseFloat(cycle.amount_due)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await this.repo.getCycleForUpdate(client, cycleId)
      await this.repo.getForUpdate(client, cycle.ledger_account_id)

      await this.repo.repay(
        client, cycle.ledger_account_id, settleAmount,
        `Settled billing cycle ${cycle.period_start} to ${cycle.period_end}`,
        { billingCycleId: cycleId }
      )
      const updatedCycle = await this.repo.markCyclePaid(client, cycleId, {
        amountPaid: settleAmount,
        paymentReference,
      })

      const stillUnpaid = await this.repo.findUnpaidCyclesForAccount(client, cycle.ledger_account_id)
      if (stillUnpaid.length === 0) {
        await client.query(
          `UPDATE ledger_accounts SET status = 'ACTIVE', updated_at = NOW()
            WHERE id = $1 AND status = 'SUSPENDED'`,
          [cycle.ledger_account_id]
        )
      }

      await client.query('COMMIT')

      logAdminActivity(
        adminId,
        `Marked B2B ledger billing cycle ${cycle.period_start} to ${cycle.period_end} as paid (₹${settleAmount})`,
        'ledger_billing_cycle', cycleId,
        { status: cycle.status }, { status: 'PAID', amountPaid: settleAmount },
        ip
      )

      return updatedCycle
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Pay for an already-placed order from the customer's B2B credit line —
   * the LEDGER-payment-method equivalent of wallet.service.js#payFromWallet.
   * Modeled directly on that method's two-step shape (orders.service.js
   * #placeOrder creates the order PENDING when paymentMethod is LEDGER,
   * same as it already does for ONLINE/legacy-WALLET; this is the second
   * step the client calls to actually settle it): lock the ledger account,
   * check headroom under the lock, draw, commit, then confirm the order
   * and fire the same post-commit cascade payFromWallet uses (auto-assign,
   * cart clear, coupon usage, notification) — deliberately skipping the
   * cashback/payment-offer reward hooks wallet-pay also fires, since those
   * are B2C loyalty mechanics that don't apply to a B2B credit purchase.
   */
  async payFromLedger(userId, orderId) {
    const account = await this.repo.findByUserId(userId)
    if (!account) {
      return { success: false, message: 'No ledger account found', code: 'LEDGER_NOT_AVAILABLE' }
    }

    const order = await this.ordersRepo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }
    if (order.paymentMethod !== 'LEDGER') {
      return { success: false, message: 'Order is not set for ledger payment' }
    }
    if (order.paymentStatus === 'PAID') {
      return { success: false, message: 'Order is already paid' }
    }

    const client = await getClient()

    try {
      await client.query('BEGIN')

      const locked = await this.repo.getForUpdate(client, account.id)
      if (!locked) {
        await client.query('ROLLBACK')
        return { success: false, message: 'No ledger account found', code: 'LEDGER_NOT_AVAILABLE' }
      }
      if (locked.status !== 'ACTIVE') {
        await client.query('ROLLBACK')
        return { success: false, message: 'Your B2B credit line is not currently active', code: 'LEDGER_NOT_ACTIVE' }
      }

      const orderTotal = Number(order.totalAmount)
      const projectedBalance = parseFloat(locked.current_balance) + orderTotal
      if (projectedBalance > parseFloat(locked.hard_limit)) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: `This order would exceed your available credit limit.`,
          code: 'LEDGER_LIMIT_EXCEEDED',
        }
      }

      const result = await this.repo.draw(
        client, account.id, orderTotal,
        `Payment for order ${order.orderNumber}`,
        { orderId: order.id }
      )

      await client.query('COMMIT')

      // Update order payment status
      await this.ordersRepo.updateStatus(orderId, 'CONFIRMED', {
        paymentStatus: 'PAID',
      })
      await this._queueAutoAssign(orderId, 'LEDGER_PAY')

      // Clear cart and send notification AFTER successful ledger draw —
      // same ordering rationale as payFromWallet (never clear/notify on a
      // draw that didn't actually happen).
      try {
        const { CartRepository } = await import('../cart/cart.repository.js')
        const cartRepo = new CartRepository()
        await cartRepo.clearCart(userId)
        await cartRepo.clearExtras(userId)
      } catch (cartErr) {
        logger.warn({ err: cartErr.message, userId }, 'Cart clear after ledger pay failed (non-critical)')
      }

      // Same deferred-confirmation reasoning as payFromWallet — a coupon
      // is only counted as used once the payment that earned it actually
      // succeeded.
      if (order.couponCode) {
        try {
          const { CouponsService } = await import('../coupons/coupons.service.js')
          const { CouponsRepository } = await import('../coupons/coupons.repository.js')
          await new CouponsService(new CouponsRepository()).recordUsageForOrder(orderId)
        } catch (couponErr) {
          logger.warn({ err: couponErr.message, orderId }, 'Coupon usage recording after ledger pay failed (non-critical)')
        }
      }

      try {
        const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
        const { NotificationsService } = await import('../notifications/notifications.service.js')
        const { buildCustomerOrderEventNotification } = await import('../notifications/customer-order-event.helper.js')
        const notifService = new NotificationsService(new NotificationsRepository(), null)
        await notifService.sendNotification(userId, buildCustomerOrderEventNotification({
          orderId: order.id,
          orderNumber: order.orderNumber,
          timelineType: 'ORDER_PLACED',
          status: 'CONFIRMED',
        }))
      } catch (notifErr) {
        logger.warn({ err: notifErr.message, orderId }, 'Notification after ledger pay failed (non-critical)')
      }

      logger.info({ userId, orderId, amount: orderTotal }, 'Ledger payment successful')

      return { success: true, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, orderId }, 'Ledger payment failed')
      return { success: false, message: 'Payment failed: ' + err.message }
    } finally {
      client.release()
    }
  }

  async _queueAutoAssign(orderId, source = 'LEDGER_SERVICE') {
    try {
      await orderQueue.add(
        'auto-assign',
        { type: 'auto-assign', orderId, source },
        { jobId: `auto-assign-${orderId}`, removeOnComplete: true }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      logger.warn({ err, orderId, source }, 'Failed to queue auto-assign job')
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../workers/processors.js')
      await processOrderJob({
        data: { type: 'auto-assign', orderId, source: `${source}_INLINE_FALLBACK` },
      })
      logger.info({ orderId, source }, 'Inline auto-assign fallback executed')
    } catch (fallbackErr) {
      logger.error({ err: fallbackErr, orderId, source }, 'Inline auto-assign fallback failed')
    }
  }
}
