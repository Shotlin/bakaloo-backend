import { logAdminActivity } from '../../../utils/activityLogger.js'
import { AdminOrdersRepository } from '../orders/orders.repository.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { NotificationsService } from '../../notifications/notifications.service.js'

export class AdminRefundRequestsService {
  constructor(repository, fastify) {
    this.repository = repository
    this.ordersRepository = new AdminOrdersRepository()
    this.fastify = fastify
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
  }

  async findAll(filters) {
    const offset = ((filters.page || 1) - 1) * (filters.limit || 20)
    const result = await this.repository.findAll({ ...filters, offset, limit: filters.limit || 20 })
    return {
      requests: result.requests,
      pagination: {
        page: filters.page || 1,
        limit: filters.limit || 20,
        total: result.total,
        totalPages: Math.ceil(result.total / (filters.limit || 20)),
      },
    }
  }

  async findById(id) {
    const request = await this.repository.findById(id)
    if (!request) throw { statusCode: 404, message: 'Refund request not found' }
    return request
  }

  async _queueNotification(userId, notif) {
    if (!this.notificationsService || !userId || !notif) return
    try {
      await this.notificationsService.sendNotification(userId, notif)
    } catch (err) {
      console.error('Failed to send customer notification:', err?.message || err)
    }
  }

  /**
   * Approves a pending refund request, computing the refund amount the same
   * way AdminOrdersService.refundOrder does — never admin-editable. For
   * ALL-item requests, it's the order's full paidAmount (payment.amount, or
   * total_amount minus wallet_amount_used for COD, same as refundOrder). For
   * SPECIFIC items, it's the sum of the snapshotted items' `total`, capped
   * at paidAmount so a partial refund can never exceed what was collected.
   */
  async approve(requestId, { refundTo = 'wallet' }, adminId, ip) {
    const request = await this.repository.findById(requestId)
    if (!request) throw { statusCode: 404, message: 'Refund request not found' }
    if (request.status !== 'PENDING') {
      throw { statusCode: 400, message: `Cannot approve a request that is already ${request.status}` }
    }

    const order = await this.ordersRepository.findById(request.order_id)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const payment = await this.ordersRepository.getOrderPayment(request.order_id)
    const paidAmount = payment
      ? parseFloat(payment.amount)
      : parseFloat(order.total_amount) - parseFloat(order.wallet_amount_used || 0)

    let refundAmount
    if (request.item_scope === 'ALL') {
      refundAmount = paidAmount
    } else {
      const itemsTotal = (request.items || []).reduce((sum, item) => sum + parseFloat(item.total || 0), 0)
      refundAmount = Math.min(itemsTotal, paidAmount)
    }

    const hasGatewayPayment = !!(payment && payment.status === 'PAID' && payment.razorpay_payment_id)
    const reason = `Refund request approved for order ${order.order_number}`

    if (refundTo === 'original') {
      if (!hasGatewayPayment) {
        throw {
          statusCode: 400,
          message: 'No online payment on this order to refund to the original method — use Wallet instead',
        }
      }
      const { PaymentsService } = await import('../../payments/payments.service.js')
      const { PaymentsRepository } = await import('../../payments/payments.repository.js')
      const result = await new PaymentsService(new PaymentsRepository()).refund(payment.id, {
        amount: refundAmount,
        reason,
      })
      if (!result.success) {
        throw { statusCode: 400, message: result.message || 'Refund failed' }
      }
    } else {
      const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
      await new AdminCustomersRepository().creditWallet(request.user_id, refundAmount, reason)
    }

    const updated = await this.repository.updateStatus(requestId, {
      status: 'APPROVED',
      adminId,
      refundAmount,
      refundTo,
    })

    logAdminActivity(
      adminId,
      `Approved refund request for order ${order.order_number} — ₹${refundAmount} via ${refundTo}`,
      'refund_request', requestId,
      { status: 'PENDING' }, { status: 'APPROVED', refundAmount, refundTo },
      ip
    )

    const refundDestination = refundTo === 'original' ? 'original payment method' : 'wallet'
    await this._queueNotification(request.user_id, {
      title: 'Refund approved',
      body: `₹${refundAmount} has been refunded to your ${refundDestination} for order ${order.order_number}.`,
      type: 'REFUND_REQUEST',
      data: { type: 'REFUND_REQUEST', requestId, orderId: request.order_id, orderNumber: order.order_number, status: 'APPROVED', refundAmount, refundTo },
    })

    try {
      this.fastify?.emitDashboardRefundRequest?.({
        id: requestId, orderId: request.order_id, orderNumber: order.order_number,
        status: 'APPROVED', refundAmount, refundTo,
      })
    } catch (_) {
      // Keep approval non-blocking if the realtime emit fails.
    }

    return updated
  }

  async reject(requestId, { adminNote }, adminId, ip) {
    const request = await this.repository.findById(requestId)
    if (!request) throw { statusCode: 404, message: 'Refund request not found' }
    if (request.status !== 'PENDING') {
      throw { statusCode: 400, message: `Cannot reject a request that is already ${request.status}` }
    }

    const updated = await this.repository.updateStatus(requestId, {
      status: 'REJECTED',
      adminId,
      adminNote,
    })

    logAdminActivity(
      adminId,
      `Rejected refund request for order ${request.order_number}`,
      'refund_request', requestId,
      { status: 'PENDING' }, { status: 'REJECTED', adminNote },
      ip
    )

    await this._queueNotification(request.user_id, {
      title: 'Refund request update',
      body: adminNote
        ? `Your refund request for order ${request.order_number} was not approved: ${adminNote}`
        : `Your refund request for order ${request.order_number} was not approved.`,
      type: 'REFUND_REQUEST',
      data: { type: 'REFUND_REQUEST', requestId, orderId: request.order_id, orderNumber: request.order_number, status: 'REJECTED' },
    })

    try {
      this.fastify?.emitDashboardRefundRequest?.({
        id: requestId, orderId: request.order_id, orderNumber: request.order_number, status: 'REJECTED',
      })
    } catch (_) {
      // Keep rejection non-blocking if the realtime emit fails.
    }

    return updated
  }
}
