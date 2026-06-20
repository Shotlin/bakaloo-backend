import crypto from 'node:crypto'
import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { razorpay } from '../../config/razorpay.js'
import { orderQueue } from '../../config/bullmq.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { OrdersRepository } from '../orders/orders.repository.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'

const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Payments service — Razorpay integration + payment management
 */
export class PaymentsService {
  constructor(repository) {
    this.repo = repository
    this.ordersRepo = new OrdersRepository()
    this.paymentSettingsService = new PaymentSettingsService()
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

    // Create Razorpay order
    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(order.totalAmount * 100), // paise
      currency: 'INR',
      receipt: order.orderNumber,
      notes: {
        orderId: order.id,
        userId,
      },
    })

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

    // Update payment record
    const updated = await this.repo.updatePayment(payment.id, {
      razorpayPaymentId,
      razorpaySignature,
      status: 'PAID',
    })

    // Update order payment status
    await this.ordersRepo.updateStatus(payment.orderId, 'CONFIRMED', {
      paymentStatus: 'PAID',
    })
    await this._queueAutoAssign(payment.orderId, 'PAYMENT_VERIFY')

    // NOW clear the cart and send "Order placed" notification — only after
    // payment is confirmed. This is the critical fix: previously the order
    // service cleared cart and sent notification at order creation time,
    // before payment verification, which caused false notifications and
    // empty carts when Razorpay payment failed.
    try {
      const { CartRepository } = await import('../cart/cart.repository.js')
      const cartRepo = new CartRepository()
      await cartRepo.clearCart(userId)
      await cartRepo.clearExtras(userId)
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'Cart clear after payment verify failed (non-critical)')
    }

    // Send order placed notification after confirmed payment
    try {
      const order = await this.ordersRepo.findByIdAndUser(payment.orderId, userId)
      if (order) {
        const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
        const { NotificationsService } = await import('../notifications/notifications.service.js')
        const { buildCustomerOrderEventNotification } = await import('../notifications/customer-order-event.helper.js')
        const notifService = new NotificationsService(new NotificationsRepository(), null)
        await notifService.sendNotification(userId, buildCustomerOrderEventNotification({
          orderId: order.id,
          orderNumber: order.orderNumber || order.order_number,
          timelineType: 'ORDER_PLACED',
          status: 'CONFIRMED',
        }))
      }
    } catch (err) {
      logger.warn({ err: err.message, orderId: payment.orderId }, 'Order notification after payment verify failed (non-critical)')
    }

    logger.info(
      { paymentId: payment.id, razorpayPaymentId, orderId: payment.orderId },
      'Payment verified successfully'
    )

    return { success: true, payment: updated }
  }

  /**
   * Handle Razorpay webhook events
   */
  async handleWebhook(body, signature) {
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      logger.warn('Razorpay webhook secret not configured')
      return { success: false }
    }

    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(JSON.stringify(body))
      .digest('hex')

    if (expectedSignature !== signature) {
      logger.warn('Webhook signature mismatch')
      return { success: false }
    }

    const event = body.event
    const payload = body.payload

    logger.info({ event }, 'Razorpay webhook received')

    switch (event) {
      case 'payment.captured': {
        const rzpPaymentId = payload.payment?.entity?.id
        const rzpOrderId = payload.payment?.entity?.order_id

        if (rzpOrderId) {
          const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
          if (payment && payment.status !== 'PAID') {
            await this.repo.updatePayment(payment.id, {
              razorpayPaymentId: rzpPaymentId,
              status: 'PAID',
              method: payload.payment?.entity?.method,
            })
            await this.ordersRepo.updateStatus(payment.orderId, 'CONFIRMED', {
              paymentStatus: 'PAID',
            })
            await this._queueAutoAssign(payment.orderId, 'PAYMENT_WEBHOOK')
            logger.info({ paymentId: payment.id }, 'Payment captured via webhook')
          }
        }
        break
      }

      case 'payment.failed': {
        const rzpOrderId = payload.payment?.entity?.order_id
        if (rzpOrderId) {
          const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
          if (payment) {
            await this.repo.updatePayment(payment.id, { status: 'FAILED' })
            await this.ordersRepo.updateStatus(payment.orderId, undefined, {
              paymentStatus: 'FAILED',
            })
            logger.info({ paymentId: payment.id }, 'Payment failed via webhook')
          }
        }
        break
      }

      case 'refund.processed': {
        const rzpPaymentId = payload.refund?.entity?.payment_id
        // Handle refund event if needed
        logger.info({ razorpayPaymentId: rzpPaymentId }, 'Refund processed via webhook')
        break
      }

      default:
        logger.debug({ event }, 'Unhandled webhook event')
    }

    return { success: true }
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
