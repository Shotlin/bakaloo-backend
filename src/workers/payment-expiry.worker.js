/**
 * Payment Expiry Worker
 * Polls every 2 minutes for PENDING online payments past their 15-minute window.
 *
 * Before cancelling anything, checks the payment directly against Razorpay's
 * own API (mirrors wallet-topup-reconciliation.worker.js). Without this, a
 * customer whose money Razorpay actually captured — but whose client-side
 * verifyPayment() call and the webhook both failed to land (app killed,
 * network drop, UPI app-switch didn't return cleanly) — would have their
 * paid order silently auto-cancelled and stock released out from under them
 * at the 15-minute mark, while Razorpay shows the payment as successful.
 * If Razorpay confirms the payment was captured, the order is confirmed
 * instead of cancelled (via PaymentsService.completeVerifiedPayment, the
 * same finalize path used by the webhook and the client verify call).
 *
 * Only truly-unpaid orders (Razorpay shows no captured payment) get
 * cancelled and have their stock restored.
 *
 * Each row is processed in its own short transaction (SELECT ... FOR UPDATE
 * at the point of cancellation) rather than one giant batch transaction, so
 * the Razorpay network round-trip per row never holds DB locks open.
 */
import { getClient, query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { razorpay } from '../config/razorpay.js'
import { PaymentsRepository } from '../modules/payments/payments.repository.js'
import { PaymentsService } from '../modules/payments/payments.service.js'
import { revokeOrderPickupTokens } from '../utils/pickupTokens.js'

let _intervalHandle = null
const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes
const BATCH_LIMIT = 20

const paymentsService = new PaymentsService(new PaymentsRepository())

export function startPaymentExpiryWorker() {
  if (_intervalHandle) return

  logger.info('Payment expiry worker started (polling every 2 min)')

  _intervalHandle = setInterval(async () => {
    try {
      await _processExpiredPayments()
    } catch (err) {
      logger.error({ err: err.message }, 'Payment expiry worker poll error')
    }
  }, POLL_INTERVAL_MS)

  // Also run immediately on startup
  _processExpiredPayments().catch(err =>
    logger.error({ err: err.message }, 'Payment expiry worker initial poll error')
  )
}

export function stopPaymentExpiryWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Payment expiry worker stopped')
  }
}

async function _processExpiredPayments() {
  // 1. Expired pending payments (new flow with expires_at).
  // Deliberately NOT filtered on o.status = 'PENDING' — a customer/admin
  // cancel does not touch orders.payment_status (only orders.status), so a
  // payment Razorpay captures a few seconds after a cancel already went
  // through would otherwise become permanently invisible to this sweep the
  // instant it's needed most. o.payment_status = 'PENDING' is the correct,
  // narrower signal: the money side of this order was never resolved,
  // regardless of what happened to its fulfillment status.
  const { rows: expired } = await query(
    `SELECT p.id AS payment_id, p.order_id, p.razorpay_order_id
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     WHERE p.status = 'PENDING'
       AND p.expires_at IS NOT NULL
       AND p.expires_at <= NOW()
       AND o.payment_status = 'PENDING'
     LIMIT ${BATCH_LIMIT}`
  )

  // 2. Legacy ONLINE PENDING orders without expires_at older than 30 min —
  // left-joined to any PENDING payment row so we can still check Razorpay
  // when one exists. Same reasoning as above for dropping o.status = 'PENDING'.
  const { rows: legacy } = await query(
    `SELECT o.id AS order_id, p.id AS payment_id, p.razorpay_order_id
     FROM orders o
     LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'PENDING'
     WHERE o.payment_method = 'ONLINE'
       AND o.payment_status = 'PENDING'
       AND o.payment_expires_at IS NULL
       AND o.created_at < NOW() - INTERVAL '30 minutes'
     LIMIT ${BATCH_LIMIT}`
  )

  const all = [
    ...expired.map(r => ({ paymentId: r.payment_id, orderId: r.order_id, razorpayOrderId: r.razorpay_order_id, isLegacy: false })),
    ...legacy.map(r => ({ paymentId: r.payment_id || null, orderId: r.order_id, razorpayOrderId: r.razorpay_order_id || null, isLegacy: true })),
  ]

  if (all.length === 0) return

  logger.info({ count: all.length, legacy: legacy.length }, 'Processing expired pending payments')

  for (const row of all) {
    try {
      await _processOneExpiredPayment(row)
    } catch (err) {
      logger.error({ err: err.message, orderId: row.orderId }, 'Payment expiry: failed to process row')
    }
  }
}

async function _processOneExpiredPayment(row) {
  if (razorpay && row.razorpayOrderId) {
    try {
      const result = await paymentsService.reconcileWithRazorpay(
        row.razorpayOrderId,
        'PAYMENT_EXPIRY_RECONCILE'
      )

      if (result.captured) {
        if (result.success) {
          logger.info(
            { orderId: row.orderId, needsManualReview: !!result.needsManualReview },
            result.needsManualReview
              ? 'Payment expiry: payment was captured for an order that already moved on — flagged for manual review'
              : 'Payment expiry: payment was actually captured, order confirmed instead of cancelled'
          )
        }
        return
      }
    } catch (err) {
      // If the Razorpay check itself fails (network/API error), do not
      // cancel blind — leave it PENDING for the next poll rather than risk
      // cancelling an order we simply failed to verify.
      logger.warn(
        { err: err.message, orderId: row.orderId },
        'Payment expiry: Razorpay verification check failed, leaving PENDING for next poll'
      )
      return
    }
  }

  await _cancelExpiredOrder(row)
}

async function _cancelExpiredOrder(row) {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const { rows: [orderRow] } = await client.query(
      `SELECT id, status, payment_status, items FROM orders WHERE id = $1 FOR UPDATE`,
      [row.orderId]
    )

    if (!orderRow) {
      await client.query('ROLLBACK')
      logger.warn({ orderId: row.orderId }, 'Payment expiry: order not found, skipping')
      return
    }

    // payment_status already resolved (PAID/FAILED/REFUNDED/EXPIRED) —
    // some other path already handled this, nothing left to do.
    if (orderRow.payment_status !== 'PENDING') {
      await client.query('ROLLBACK')
      logger.info(
        { orderId: row.orderId, status: orderRow.status, paymentStatus: orderRow.payment_status },
        'Payment expiry: order already processed, skipping'
      )
      return
    }

    // Order already left PENDING (almost always CANCELLED, via the
    // customer/admin cancel flow, which does not touch payment_status) but
    // Razorpay showed no captured payment for it either — a genuinely
    // abandoned payment on an order that's already been dealt with. Stock
    // was already restored when it was cancelled; don't restore it again
    // or touch order status a second time. Just close out the dangling
    // PENDING payment row so it stops being re-swept every 2 minutes forever.
    if (orderRow.status !== 'PENDING') {
      await client.query(
        `UPDATE payments SET status = 'EXPIRED', updated_at = NOW()
         WHERE order_id = $1 AND status = 'PENDING'`,
        [row.orderId]
      )
      await client.query(
        `UPDATE orders SET payment_status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
        [row.orderId]
      )
      await client.query('COMMIT')
      logger.info(
        { orderId: row.orderId, orderStatus: orderRow.status },
        'Payment expiry: order already left PENDING with no Razorpay capture found — closed out the dangling payment, no stock/order changes'
      )
      return
    }

    // Restore shop_products stock for each item in the order
    const items = typeof orderRow.items === 'string'
      ? JSON.parse(orderRow.items)
      : (orderRow.items || [])

    for (const item of items) {
      const qty = Number(item.quantity)
      if (!qty || qty <= 0) continue

      const shopProductId = item.shopProductId || item.shop_product_id || null
      const productId = item.productId || item.product_id || null
      const shopId = item.shopId || item.shop_id || null

      if (shopProductId) {
        // Phase 3 exact path
        await client.query(
          `UPDATE shop_products
           SET stock_quantity = stock_quantity + $1,
               is_available = CASE
                 WHEN stock_quantity = 0 AND $1 > 0 THEN true
                 ELSE is_available
               END,
               sold_out_at = CASE
                 WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
                 ELSE sold_out_at
               END,
               updated_at = NOW()
           WHERE id = $2 AND deleted_at IS NULL`,
          [qty, shopProductId]
        )
      } else if (productId && shopId) {
        // Legacy path: resolve via (product_id, shop_id)
        await client.query(
          `UPDATE shop_products
           SET stock_quantity = stock_quantity + $1,
               is_available = CASE
                 WHEN stock_quantity = 0 AND $1 > 0 THEN true
                 ELSE is_available
               END,
               sold_out_at = CASE
                 WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
                 ELSE sold_out_at
               END,
               updated_at = NOW()
           WHERE product_id = $2 AND shop_id = $3 AND deleted_at IS NULL`,
          [qty, productId, shopId]
        )
      }
    }

    logger.info({ orderId: row.orderId, itemCount: items.length }, 'Payment expiry: stock restored for order items')

    if (row.paymentId) {
      await client.query(
        `UPDATE payments SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
        [row.paymentId]
      )
    }

    // Also expire any other PENDING payment records for this order
    await client.query(
      `UPDATE payments SET status = 'EXPIRED', updated_at = NOW()
       WHERE order_id = $1 AND status = 'PENDING'`,
      [row.orderId]
    )

    await client.query(
      `UPDATE orders
       SET status = 'CANCELLED',
           payment_status = 'EXPIRED',
           cancelled_reason = 'Payment window expired (15 minutes)',
           updated_at = NOW()
       WHERE id = $1
         AND status = 'PENDING'
         AND payment_status = 'PENDING'`,
      [row.orderId]
    )

    // A PENDING order never has a pickup token yet (those only mint once
    // the order reaches PACKED), so this is a no-op in practice — included
    // for defense-in-depth consistency with every other CANCELLED path.
    await revokeOrderPickupTokens(client, row.orderId, 'Payment window expired')

    await client.query('COMMIT')

    logger.info(
      { paymentId: row.paymentId, orderId: row.orderId, isLegacy: row.isLegacy },
      'Expired payment cancelled'
    )
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
