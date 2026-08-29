import crypto from 'node:crypto'
import Razorpay from 'razorpay'
import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { getClient } from '../../config/database.js'
import { razorpay } from '../../config/razorpay.js'
import { orderQueue } from '../../config/bullmq.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { OrdersRepository } from '../orders/orders.repository.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { CashbackService } from '../cashback/cashback.service.js'
import { WalletService } from '../wallet/wallet.service.js'
import { WalletRepository } from '../wallet/wallet.repository.js'

const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Payments service — Razorpay integration + payment management
 */
export class PaymentsService {
  constructor(repository, fastify = null) {
    this.fastify = fastify
    this.repo = repository
    this.ordersRepo = new OrdersRepository()
    this.paymentSettingsService = new PaymentSettingsService()
    this.cashbackService = new CashbackService()
    this.walletService = new WalletService(new WalletRepository())
  }

  /**
   * Create a Razorpay order for an existing app order
   */
  async createPaymentOrder(userId, orderId) {
    if (!razorpay) {
      return { success: false, message: 'Online payments are not configured' }
    }

    const { razorpayEnabled } = await this.paymentSettingsService.getConfig()
    if (!razorpayEnabled) {
      return { success: false, message: 'Online payment is currently unavailable.' }
    }

    const order = await this.ordersRepo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    if (order.paymentMethod !== 'ONLINE') {
      return { success: false, message: 'Order is not set for online payment' }
    }

    if (order.paymentStatus === 'PAID') {
      return { success: false, message: 'Order is already paid' }
    }

    // Check if payment record already exists
    const existing = await this.repo.findByOrderId(orderId)
    if (existing && existing.status === 'PAID') {
      return { success: false, message: 'Payment already completed' }
    }

    // Create Razorpay order. The razorpay SDK throws errors carrying a
    // `statusCode` mirrored from Razorpay's own API response (e.g. 401
    // when our API credentials are rejected) — left uncaught, that
    // error reaches the global error handler, which forwards
    // `error.statusCode` verbatim (errorHandler.plugin.js). A 401 from
    // Razorpay would then look identical to the customer's own session
    // being invalid, sending them on a wild goose chase re-logging in
    // for a problem that's actually on our Razorpay account config.
    // Catching here keeps upstream provider failures mapped to this
    // module's normal `{ success: false }` contract (→ HTTP 400).
    let rzpOrder
    try {
      rzpOrder = await razorpay.orders.create({
        amount: Math.round(order.totalAmount * 100), // paise
        currency: 'INR',
        receipt: order.orderNumber,
        notes: {
          orderId: order.id,
          userId,
        },
      })
    } catch (err) {
      logger.error(
        { err: err.error || err.message, statusCode: err.statusCode, orderId },
        'Razorpay order creation failed'
      )
      return { success: false, message: 'Unable to start online payment right now. Please try again shortly.' }
    }

    // Payment expires in 15 minutes — after this the cleanup worker will
    // cancel the order and release any reserved stock.
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    // Save payment record
    const payment = await this.repo.create({
      orderId: order.id,
      userId,
      razorpayOrderId: rzpOrder.id,
      amount: order.totalAmount,
      currency: 'INR',
      status: 'PENDING',
      expiresAt,
      metadata: { receipt: order.orderNumber },
    })

    // Update the order with payment expiry so the cleanup worker can find it
    await this.ordersRepo.updateStatus(order.id, undefined, {
      paymentExpiresAt: expiresAt,
    })

    logger.info(
      { paymentId: payment.id, razorpayOrderId: rzpOrder.id, orderId },
      'Razorpay payment order created'
    )

    return {
      success: true,
      data: {
        paymentId: payment.id,
        razorpayOrderId: rzpOrder.id,
        amount: order.totalAmount,
        currency: 'INR',
        keyId: env.RAZORPAY_KEY_ID,
      },
    }
  }

  /**
   * Verify payment signature from Razorpay client-side callback
   */
  async verifyPayment(userId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
    const payment = await this.repo.findByRazorpayOrderId(razorpayOrderId)
    if (!payment) {
      return { success: false, message: 'Payment record not found' }
    }

    if (payment.userId !== userId) {
      return { success: false, message: 'Unauthorized' }
    }

    // Idempotency guard: the webhook or the payment-expiry reconciliation
    // check (both call completeVerifiedPayment()) can win the race and
    // already mark this PAID before this client call lands — e.g. the app
    // was slow to call /verify after the Razorpay checkout closed. Re-running
    // the block below would re-send the "order placed" notification and
    // re-run every other side effect a second time.
    if (payment.status === 'PAID') {
      return { success: true, payment }
    }

    // HMAC-SHA256 verification
    const expectedSignature = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex')

    if (expectedSignature !== razorpaySignature) {
      logger.warn({ razorpayOrderId }, 'Payment signature verification failed')

      await this.repo.updatePayment(payment.id, { status: 'FAILED' })
      await this.ordersRepo.updateStatus(payment.orderId, undefined, {
        paymentStatus: 'FAILED',
      })

      return { success: false, message: 'Payment verification failed' }
    }

    const result = await this.completeVerifiedPayment(razorpayOrderId, {
      razorpayPaymentId,
      razorpaySignature,
      source: 'PAYMENT_VERIFY',
    })

    if (!result.success) {
      return result
    }

    logger.info(
      { paymentId: payment.id, razorpayPaymentId, orderId: payment.orderId },
      'Payment verified successfully'
    )

    return { success: true, payment: result.payment }
  }

  /**
   * Safety net for order payments — completes a PENDING payment once we
   * have independent confirmation (not necessarily from the client) that
   * Razorpay actually captured it. Callers:
   *   - verifyPayment() above, the normal client-side confirmation
   *   - the Razorpay webhook (payment.captured), when configured
   *   - the payment-expiry worker, which polls Razorpay directly before
   *     ever cancelling a PENDING order — so a customer whose verifyPayment()
   *     call never landed (app killed, network drop, UPI app-switch didn't
   *     return cleanly) never gets their already-paid order auto-cancelled
   *     from under them. Mirrors WalletService.completeVerifiedTopUp for
   *     the exact same class of bug.
   *
   * Idempotent: only acts on a payment still PENDING. Already-PAID (another
   * caller won the race) or FAILED/EXPIRED rows are left alone. The
   * PENDING-check-and-transition happens inside a single transaction with
   * a `SELECT ... FOR UPDATE` row lock, so two callers racing on the same
   * payment (e.g. the webhook and the client's /verify call landing within
   * milliseconds of each other) serialize instead of both reading PENDING
   * and both running the cascade below (duplicate notification, duplicate
   * cashback credit — cashback's own row has no equivalent lock, so it was
   * relying entirely on this method to not call it twice). Mirrors
   * WalletService.completeVerifiedTopUp's transaction shape. No network
   * calls happen inside the transaction — same reasoning as
   * payment-expiry.worker.js's header comment: never hold a DB lock across
   * a Razorpay round-trip.
   *
   * Also guards against re-confirming an order that has moved on (almost
   * always CANCELLED) since the payment was created. This closes a real
   * hole: orders.service.js's cancel() restores stock the moment its own
   * live Razorpay check comes back empty, but that check can miss a
   * capture that posts a few seconds later — exactly this bug's timing.
   * Without this guard, a delayed webhook/reconciliation would silently
   * flip that order back to CONFIRMED and queue a rider to fetch stock
   * that's already back on the shelf (and may already be sold to someone
   * else). Instead, the payment is marked PAID (the money is tracked) but
   * flagged `needs_manual_review` and none of the confirm cascade runs —
   * a human decides via the dashboard whether to re-confirm or refund.
   */
  async completeVerifiedPayment(razorpayOrderId, { razorpayPaymentId, razorpaySignature, method, source = 'RECONCILIATION' } = {}) {
    const client = await getClient()
    let payment
    let needsManualReview = false

    try {
      await client.query('BEGIN')

      const { rows: [paymentRow] } = await client.query(
        `SELECT id, order_id, user_id, status, amount FROM payments WHERE razorpay_order_id = $1 FOR UPDATE`,
        [razorpayOrderId]
      )
      if (!paymentRow) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Payment record not found' }
      }
      payment = { id: paymentRow.id, orderId: paymentRow.order_id, userId: paymentRow.user_id }

      if (paymentRow.status === 'PAID') {
        await client.query('ROLLBACK')
        return { success: true, skipped: true, payment: await this.repo.findById(payment.id) }
      }
      if (paymentRow.status !== 'PENDING') {
        await client.query('ROLLBACK')
        return { success: true, skipped: true, reason: paymentRow.status, payment: await this.repo.findById(payment.id) }
      }

      const { rows: [orderRow] } = await client.query(
        `SELECT id, status, order_number FROM orders WHERE id = $1 FOR UPDATE`,
        [payment.orderId]
      )
      const orderStillPending = orderRow?.status === 'PENDING'

      if (!orderStillPending) {
        needsManualReview = true
        await client.query(
          `UPDATE payments SET
             razorpay_payment_id = $1, razorpay_signature = $2, status = 'PAID', method = $3,
             metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
           WHERE id = $5`,
          [
            razorpayPaymentId || null,
            razorpaySignature || null,
            method || null,
            JSON.stringify({
              needs_manual_review: true,
              reason: 'captured_after_cancel',
              order_status_at_capture: orderRow?.status || 'UNKNOWN',
            }),
            payment.id,
          ]
        )
        await client.query('COMMIT')

        logger.warn(
          { paymentId: payment.id, orderId: payment.orderId, orderStatus: orderRow?.status, source },
          'Payment captured for an order that is no longer PENDING — flagged for manual review, NOT auto-confirmed'
        )

        // Ping the admin dashboard live — this is the one outcome of this
        // whole reconciliation flow that genuinely needs a human, so it's
        // the only case that raises a notification (a routine successful
        // payment doesn't need anyone's attention and isn't emitted here).
        this.fastify?.emitDashboardPayment?.({
          orderId: payment.orderId,
          orderNumber: orderRow?.order_number,
          orderStatus: orderRow?.status,
          amount: paymentRow.amount ? parseFloat(paymentRow.amount) : null,
        })

        return {
          success: true,
          needsManualReview: true,
          payment: await this.repo.findById(payment.id),
        }
      }

      await client.query(
        `UPDATE payments SET
           razorpay_payment_id = $1, razorpay_signature = $2, status = 'PAID', method = $3, updated_at = NOW()
         WHERE id = $4`,
        [razorpayPaymentId || null, razorpaySignature || null, method || null, payment.id]
      )
      await client.query(
        `UPDATE orders SET status = 'CONFIRMED', payment_status = 'PAID', updated_at = NOW() WHERE id = $1`,
        [payment.orderId]
      )

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, razorpayOrderId }, 'Payment finalize transaction failed')
      return { success: false, message: 'Payment finalize failed: ' + err.message }
    } finally {
      client.release()
    }

    if (needsManualReview) {
      // Unreachable (the branch above already returned) — guard kept only
      // so a future refactor that reorders this function fails loudly
      // instead of silently running the cascade on a flagged payment.
      return { success: true, needsManualReview: true, payment: await this.repo.findById(payment.id) }
    }

    // Everything below only runs once the transaction above has committed
    // the order to CONFIRMED — never for the manual-review branch, which
    // already returned above without reaching here.
    await this._queueAutoAssign(payment.orderId, source)

    this.fastify?.emitOrderUpdate?.(payment.orderId, [payment.userId], {
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    })

    // Credit any cashback whose trigger is PAYMENT_SUCCESS or
    // ORDER_CONFIRMED — this call also confirms the order, so both
    // triggers are satisfied at the same moment. Fire-and-forget.
    this.cashbackService.evaluateAndCredit(payment.orderId, 'PAYMENT_SUCCESS').catch((err) => {
      logger.warn({ err: err.message, orderId: payment.orderId }, 'Cashback evaluation failed (payment finalize)')
    })
    this.cashbackService.evaluateAndCredit(payment.orderId, 'ORDER_CONFIRMED').catch((err) => {
      logger.warn({ err: err.message, orderId: payment.orderId }, 'Cashback evaluation failed (payment finalize)')
    })

    // NOW clear the cart and send "Order placed" notification — only after
    // payment is confirmed. This is the critical fix: previously the order
    // service cleared cart and sent notification at order creation time,
    // before payment verification, which caused false notifications and
    // empty carts when Razorpay payment failed.
    try {
      const { CartRepository } = await import('../cart/cart.repository.js')
      const cartRepo = new CartRepository()
      await cartRepo.clearCart(payment.userId)
      await cartRepo.clearExtras(payment.userId)
    } catch (err) {
      logger.warn({ err: err.message, userId: payment.userId }, 'Cart clear after payment finalize failed (non-critical)')
    }

    // Same "only after payment is confirmed" reasoning as the cart clear
    // above — a coupon's usage must not count against the customer's limit
    // until the order it was used on is actually confirmed.
    try {
      const { CouponsService } = await import('../coupons/coupons.service.js')
      const { CouponsRepository } = await import('../coupons/coupons.repository.js')
      await new CouponsService(new CouponsRepository()).recordUsageForOrder(payment.orderId)
    } catch (err) {
      logger.warn({ err: err.message, orderId: payment.orderId }, 'Coupon usage recording after payment finalize failed (non-critical)')
    }

    // Send order placed notification after confirmed payment
    try {
      const order = await this.ordersRepo.findByIdAndUser(payment.orderId, payment.userId)
      if (order) {
        const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
        const { NotificationsService } = await import('../notifications/notifications.service.js')
        const { buildCustomerOrderEventNotification } = await import('../notifications/customer-order-event.helper.js')
        const notifService = new NotificationsService(new NotificationsRepository(), null)
        await notifService.sendNotification(payment.userId, buildCustomerOrderEventNotification({
          orderId: order.id,
          orderNumber: order.orderNumber || order.order_number,
          timelineType: 'ORDER_PLACED',
          status: 'CONFIRMED',
        }))

        this.fastify?.emitDashboardNewOrder?.({
          id: order.id,
          order_number: order.orderNumber,
          total: order.totalAmount,
          payment_method: 'ONLINE',
          delivery_mode: order.deliveryMode,
          created_at: order.createdAt,
        })
      }
    } catch (err) {
      logger.warn({ err: err.message, orderId: payment.orderId }, 'Order notification after payment finalize failed (non-critical)')
    }

    logger.info(
      { paymentId: payment.id, razorpayPaymentId, orderId: payment.orderId, source },
      'Payment finalized'
    )

    return { success: true, payment: await this.repo.findById(payment.id) }
  }

  /**
   * Full payment detail straight from Razorpay's own record — everything
   * they track that this app doesn't keep a column for (UPI VPA, bank/card
   * used, wallet name, Razorpay's fee + tax, the acquirer reference number
   * banks ask for in disputes, capture timestamps, refund status). Fetched
   * live on demand rather than mirrored into our own schema ahead of time,
   * so it's always complete and current — including anything Razorpay adds
   * later — instead of us guessing which fields matter.
   */
  async getFullRazorpayDetails(razorpayPaymentId) {
    if (!razorpay || !razorpayPaymentId) {
      return null
    }
    const p = await razorpay.payments.fetch(razorpayPaymentId, { expand: ['card'] })
    return {
      id: p.id,
      status: p.status,
      method: p.method,
      amount: p.amount / 100,
      amountRefunded: p.amount_refunded ? p.amount_refunded / 100 : 0,
      refundStatus: p.refund_status || null,
      currency: p.currency,
      fee: p.fee != null ? p.fee / 100 : null,
      tax: p.tax != null ? p.tax / 100 : null,
      international: !!p.international,
      email: p.email || null,
      contact: p.contact || null,
      vpa: p.vpa || null,
      bank: p.bank || null,
      wallet: p.wallet || null,
      card: p.card
        ? { last4: p.card.last4, network: p.card.network, type: p.card.type, issuer: p.card.issuer }
        : null,
      acquirerReference: p.acquirer_data?.rrn || p.acquirer_data?.bank_transaction_id || null,
      upiTransactionId: p.acquirer_data?.upi_transaction_id || null,
      createdAt: p.created_at ? new Date(p.created_at * 1000).toISOString() : null,
      errorCode: p.error_code || null,
      errorDescription: p.error_description || null,
      errorReason: p.error_reason || null,
      notes: p.notes || null,
    }
  }

  /**
   * Poll Razorpay directly for a captured payment on this order and, if
   * found, run it through completeVerifiedPayment(). Shared by the
   * payment-expiry worker, the cancel-time reconciliation check, and the
   * admin "re-check with Razorpay" action — previously three independent
   * copies of the same fetchPayments-then-finalize sequence.
   *
   * Returns { captured: false } when Razorpay shows no captured payment —
   * safe for the caller to proceed with whatever it was about to do
   * (cancel, expire, etc). Throws on a Razorpay API/network failure —
   * callers must fail safe (never treat a failed check as "not captured").
   */
  async reconcileWithRazorpay(razorpayOrderId, source = 'RECONCILIATION') {
    if (!razorpay || !razorpayOrderId) {
      return { captured: false }
    }

    const payments = await razorpay.orders.fetchPayments(razorpayOrderId)
    const captured = (payments.items || []).find((p) => p.status === 'captured')
    if (!captured) {
      return { captured: false }
    }

    const result = await this.completeVerifiedPayment(razorpayOrderId, {
      razorpayPaymentId: captured.id,
      method: captured.method,
      source,
    })

    return { captured: true, ...result }
  }

  /**
   * Handle Razorpay webhook events
   */
  async handleWebhook(body, signature, rawBody) {
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      logger.warn('Razorpay webhook secret not configured')
      return { success: false }
    }

    // Verify webhook signature against the RAW bytes Razorpay signed — NOT
    // a re-serialized copy of the parsed body. JSON.stringify(JSON.parse(raw))
    // is not guaranteed to reproduce `raw` (₹ symbols, accented names, URLs
    // with escaped slashes, or certain numeric-looking keys all break the
    // round-trip), so the previous version of this check silently rejected
    // real deliveries. `rawBody` is populated by the fastify-raw-body plugin
    // registered at the root app scope (see app.js) for any route whose
    // config declares `{ rawBody: true }` — both webhook routes already do.
    if (!rawBody) {
      logger.error('Razorpay webhook: raw body unavailable — cannot verify signature, rejecting')
      return { success: false }
    }

    const validSignature = Razorpay.validateWebhookSignature(
      rawBody,
      signature,
      env.RAZORPAY_WEBHOOK_SECRET
    )

    if (!validSignature) {
      logger.warn('Webhook signature mismatch')
      return { success: false }
    }

    const event = body.event
    const payload = body.payload

    logger.info({ event }, 'Razorpay webhook received')

    switch (event) {
      case 'payment.authorized':
      case 'order.paid':
      case 'payment.captured': {
        const rzpPaymentId = payload.payment?.entity?.id
        const rzpOrderId = payload.payment?.entity?.order_id

        if (rzpOrderId) {
          const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
          if (payment) {
            // completeVerifiedPayment() carries the full finalize sequence
            // (cart clear, coupon usage, "order placed" notification,
            // dashboard emit) — previously this webhook branch only flipped
            // the PAID/CONFIRMED status and skipped all of that, so a
            // customer whose client-side verifyPayment() call never landed
            // still had a paid order but a non-empty cart and no
            // confirmation notification, even after the webhook "fixed" it.
            const result = await this.completeVerifiedPayment(rzpOrderId, {
              razorpayPaymentId: rzpPaymentId,
              method: payload.payment?.entity?.method,
              source: 'PAYMENT_WEBHOOK',
            })
            if (result.success && !result.skipped) {
              logger.info({ paymentId: payment.id }, 'Payment captured via webhook')
            }
          } else {
            // Not a checkout order payment — check whether it's a wallet
            // top-up instead (a completely separate Razorpay order created
            // directly by WalletService, not the orders/payments module).
            this.walletService.completeVerifiedTopUp(rzpOrderId).catch((err) => {
              logger.warn({ err: err.message, rzpOrderId }, 'Wallet top-up webhook completion failed')
            })
          }
        }
        break
      }

      case 'payment.failed': {
        const rzpOrderId = payload.payment?.entity?.order_id
        const entity = payload.payment?.entity || {}
        if (rzpOrderId) {
          const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
          // Only act on a payment still PENDING — mirrors completeVerifiedPayment's
          // own guard, so a failed-payment webhook arriving after this
          // order was already confirmed by some other signal (client
          // verify, a different reconciliation pass) can't undo a real
          // success. Razorpay does not retry a captured payment as failed,
          // but nothing stops a slow/duplicate webhook delivery.
          if (payment && payment.status === 'PENDING') {
            await this.repo.updatePayment(payment.id, {
              status: 'FAILED',
              errorCode: entity.error_code || null,
              errorDescription: entity.error_description || null,
              errorSource: entity.error_source || null,
              errorStep: entity.error_step || null,
              errorReason: entity.error_reason || null,
            })
            await this.ordersRepo.updateStatus(payment.orderId, undefined, {
              paymentStatus: 'FAILED',
            })
            logger.info({ paymentId: payment.id, errorReason: entity.error_reason }, 'Payment failed via webhook')
          }
        }
        break
      }

      case 'refund.processed': {
        const rzpPaymentId = payload.refund?.entity?.payment_id
        const refundEntity = payload.refund?.entity || {}
        if (rzpPaymentId) {
          try {
            const { query } = await import('../../config/database.js')
            const { rows } = await query(
              `SELECT id, order_id, status FROM payments WHERE razorpay_payment_id = $1`,
              [rzpPaymentId]
            )
            const paymentRow = rows[0]
            // Only act once — a payment already REFUNDED here means our own
            // admin-initiated refund() already handled this (and already
            // updated the order), so this webhook is just Razorpay's async
            // confirmation of an action we took ourselves, not new
            // information from the dashboard.
            if (paymentRow && paymentRow.status !== 'REFUNDED') {
              await this.repo.updateRefund(paymentRow.id, {
                refundId: refundEntity.id || null,
                refundAmount: refundEntity.amount ? refundEntity.amount / 100 : null,
                refundStatus: 'PROCESSED',
              })
              await this.ordersRepo.updateStatus(paymentRow.order_id, 'REFUNDED', {
                paymentStatus: 'REFUNDED',
              })
              logger.info({ paymentId: paymentRow.id, razorpayPaymentId: rzpPaymentId }, 'Refund processed via webhook')
            } else if (!paymentRow) {
              logger.warn({ razorpayPaymentId: rzpPaymentId }, 'Refund webhook: no matching payment found')
            }
          } catch (err) {
            logger.warn({ err: err.message, razorpayPaymentId: rzpPaymentId }, 'Refund webhook persistence failed')
          }
        }
        break
      }

      default:
        logger.debug({ event }, 'Unhandled webhook event')
    }

    return { success: true }
  }

  /**
   * Current status of a Razorpay order, for the client to poll after an
   * ambiguous checkout result (Razorpay SDK error that isn't a genuine
   * user cancellation) instead of assuming failure and cancelling blind.
   */
  async getPaymentStatus(userId, razorpayOrderId) {
    const payment = await this.repo.findByRazorpayOrderId(razorpayOrderId)
    if (!payment) {
      return { success: false, message: 'Payment record not found' }
    }
    if (payment.userId !== userId) {
      return { success: false, message: 'Unauthorized' }
    }

    return {
      success: true,
      data: {
        status: payment.status,
        orderId: payment.orderId,
        errorCode: payment.errorCode,
        errorDescription: payment.errorDescription,
        errorReason: payment.errorReason,
      },
    }
  }

  /**
   * Get payment history for a user
   */
  async getHistory(userId, filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { payments, total } = await this.repo.findByUser(userId, { limit, offset })

    return {
      payments,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Admin: initiate refund
   */
  async refund(paymentId, { amount, reason }) {
    if (!razorpay) {
      return { success: false, message: 'Online payments are not configured' }
    }

    const payment = await this.repo.findById(paymentId)
    if (!payment) {
      return { success: false, message: 'Payment not found' }
    }

    if (payment.status !== 'PAID') {
      return { success: false, message: 'Only paid payments can be refunded' }
    }

    if (!payment.razorpayPaymentId) {
      return { success: false, message: 'No Razorpay payment ID — cannot refund' }
    }

    const refundAmount = amount || payment.amount
    if (refundAmount > payment.amount) {
      return { success: false, message: 'Refund amount exceeds payment amount' }
    }

    try {
      const rzpRefund = await razorpay.payments.refund(payment.razorpayPaymentId, {
        amount: Math.round(refundAmount * 100),
        notes: { reason: reason || 'Admin initiated refund' },
      })

      const updated = await this.repo.updateRefund(payment.id, {
        refundId: rzpRefund.id,
        refundAmount,
        refundStatus: 'PROCESSED',
      })

      // Update order status to refunded
      await this.ordersRepo.updateStatus(payment.orderId, 'REFUNDED', {
        paymentStatus: 'REFUNDED',
      })

      logger.info({ paymentId, refundId: rzpRefund.id, refundAmount }, 'Refund initiated')
      return { success: true, payment: updated }
    } catch (err) {
      logger.error({ err, paymentId }, 'Refund failed')
      return { success: false, message: 'Refund failed: ' + err.message }
    }
  }

  async _queueAutoAssign(orderId, source = 'PAYMENTS_SERVICE') {
    try {
      await orderQueue.add(
        'auto-assign',
        {
          type: 'auto-assign',
          orderId,
          source,
        },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
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
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
      logger.info({ orderId, source }, 'Inline auto-assign fallback executed')
    } catch (fallbackErr) {
      logger.error(
        { err: fallbackErr, orderId, source },
        'Inline auto-assign fallback failed'
      )
    }
  }
}
