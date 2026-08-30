import { OrdersRepository } from '../orders/orders.repository.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'

export class RefundRequestsService {
  constructor(repository, fastify) {
    this.repository = repository
    this.ordersRepository = new OrdersRepository()
    this.fastify = fastify
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
  }

  async createRequest(userId, { orderId, itemScope, productIds, description }) {
    const order = await this.ordersRepository.findByIdAndUser(orderId, userId)
    if (!order) {
      throw { statusCode: 404, message: 'Order not found' }
    }

    if (order.status !== 'DELIVERED' || order.paymentStatus !== 'PAID') {
      throw {
        statusCode: 400,
        message: 'Refund requests can only be raised for delivered, paid orders',
      }
    }

    // Only a request the customer themselves cancelled leaves the order
    // eligible for a fresh submission — an APPROVED order was already
    // refunded, and a REJECTED one was already reviewed and denied, so
    // resubmitting the same complaint isn't allowed either.
    const existing = await this.repository.findLatestByOrder(orderId)
    if (existing && existing.status !== 'CANCELLED') {
      const messages = {
        PENDING: 'A refund request is already pending for this order',
        APPROVED: 'This order has already been refunded',
        REJECTED: 'A refund request for this order was already reviewed and rejected',
      }
      throw { statusCode: 400, message: messages[existing.status] || 'A refund request already exists for this order' }
    }

    let items = null
    if (itemScope === 'SPECIFIC') {
      if (!productIds || productIds.length === 0) {
        throw { statusCode: 400, message: 'Select at least one item' }
      }
      const matches = await this.repository.getMatchingOrderItems(orderId, productIds)
      if (matches.length !== productIds.length) {
        throw { statusCode: 400, message: 'One or more selected items do not belong to this order' }
      }
      items = matches.map((m) => ({
        productId: m.productId,
        name: m.name,
        quantity: m.quantity,
        total: parseFloat(m.total),
      }))
    }

    const request = await this.repository.create(userId, { orderId, itemScope, items, description })

    if (this.notificationsService) {
      await this.notificationsService.sendNotification(userId, {
        title: 'Refund request received',
        body: `We've received your request for order ${order.orderNumber}. Our team will review it and connect with you within 24 hours.`,
        type: 'REFUND_REQUEST',
        data: { type: 'REFUND_REQUEST', requestId: request.id, orderId, orderNumber: order.orderNumber, status: 'PENDING' },
      })
    }

    try {
      this.fastify?.emitDashboardRefundRequest?.({
        id: request.id,
        orderId,
        orderNumber: order.orderNumber,
        userId,
        itemScope,
        status: 'PENDING',
        createdAt: request.created_at,
      })
    } catch (_) {
      // Keep request creation non-blocking if the realtime emit fails.
    }

    return request
  }

  async getUserRequests(userId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getUserRequests(userId, { offset, limit })
  }

  /** Latest refund request for one order — powers the order-detail screen's status card. */
  async getByOrder(userId, orderId) {
    const order = await this.ordersRepository.findByIdAndUser(orderId, userId)
    if (!order) {
      throw { statusCode: 404, message: 'Order not found' }
    }
    return await this.repository.findLatestByOrder(orderId)
  }

  async cancelRequest(userId, requestId) {
    const request = await this.repository.findByIdAndUser(requestId, userId)
    if (!request) {
      throw { statusCode: 404, message: 'Refund request not found' }
    }
    if (request.status !== 'PENDING') {
      throw { statusCode: 400, message: `Cannot cancel a request that is already ${request.status.toLowerCase()}` }
    }

    const cancelled = await this.repository.cancel(requestId)

    try {
      this.fastify?.emitDashboardRefundRequest?.({
        id: requestId,
        orderId: request.order_id,
        status: 'CANCELLED',
      })
    } catch (_) {
      // Keep cancellation non-blocking if the realtime emit fails.
    }

    return cancelled
  }
}
