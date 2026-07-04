import { notificationQueue, orderQueue } from '../../../config/bullmq.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { generateInvoicePDF } from '../../../utils/invoiceGenerator.js'
import { query as dbQuery } from '../../../config/database.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { NotificationsService } from '../../notifications/notifications.service.js'
import { buildCustomerOrderEventNotification } from '../../notifications/customer-order-event.helper.js'
import ExcelJS from 'exceljs'

const ASSIGNABLE_ORDER_STATUSES = new Set(['CONFIRMED', 'PREPARING', 'PACKED'])
const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

const ALLOWED_TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['PACKED', 'CANCELLED'],
  PACKED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
}

export class AdminOrdersService {
  constructor(repository, fastify) {
    this.repository = repository
    this.fastify = fastify
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
  }

  /**
   * Send a customer push/in-app notification, best-effort. Mirrors the
   * working pattern already used by delivery.service.js — the previous
   * `notificationQueue.add('order-status-changed', ...)` calls here were a
   * dead path: the BullMQ notification worker only handles job.data.type
   * values 'push'/'in-app'/'order-status', but these calls never set a
   * `type` field, so every admin-driven order-status/cancel/refund
   * notification silently no-op'd since the feature was first built.
   */
  async _queueNotification(userId, notif) {
    if (!this.notificationsService || !userId || !notif) return
    try {
      await this.notificationsService.sendNotification(userId, notif)
    } catch (err) {
      console.error('Failed to send customer notification:', err?.message || err)
    }
  }

  async findAll(filters) {
    const offset = ((filters.page || 1) - 1) * (filters.limit || 20)
    const result = await this.repository.findAll({ ...filters, offset, limit: filters.limit || 20 })
    return {
      orders: result.orders,
      pagination: {
        page: filters.page || 1,
        limit: filters.limit || 20,
        total: result.total,
        totalPages: Math.ceil(result.total / (filters.limit || 20)),
      },
    }
  }

  async getStatsByStatus() {
    return this.repository.getStatsByStatus()
  }

  async findById(orderId) {
    const [order, items, timeline, payment, delivery] = await Promise.all([
      this.repository.findById(orderId),
      this.repository.getOrderItems(orderId),
      this.repository.getOrderTimeline(orderId),
      this.repository.getOrderPayment(orderId),
      this.repository.getOrderDelivery(orderId),
    ])
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    return { ...order, items, timeline, payment, delivery }
  }

  async updateStatus(orderId, newStatus, adminId, note, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const allowed = ALLOWED_TRANSITIONS[order.status]
    if (!allowed || !allowed.includes(newStatus)) {
      throw { statusCode: 400, message: `Cannot transition from ${order.status} to ${newStatus}` }
    }

    const oldStatus = await this.repository.updateStatus(orderId, newStatus, adminId, note)

    logAdminActivity(adminId, `Order status: ${oldStatus} → ${newStatus}`, 'order', orderId,
      { status: oldStatus }, { status: newStatus }, ip)

    // Push/in-app notification to the customer
    await this._queueNotification(order.user_id, buildCustomerOrderEventNotification({
      orderId, orderNumber: order.order_number, timelineType: newStatus, status: newStatus,
    }))

    this._emitOrderStatus(order, newStatus)

    // AUTO-ASSIGN RIDER when order is CONFIRMED and no rider assigned yet
    if (ASSIGNABLE_ORDER_STATUSES.has(newStatus) && !order.rider_id) {
      try {
        await this._queueAutoAssign(orderId, `ADMIN_STATUS_${newStatus}`)
      } catch (err) {
        // Don't fail the status update — admin can still manually assign
        console.error('Auto-assign failed (non-blocking):', err.message)
      }
    }

    return { orderId, oldStatus, newStatus }
  }

  /**
   * Change an order's scheduled delivery slot after the fact — the
   * mistake-correction path (e.g. store closed unexpectedly and existing
   * pending orders need their promised slot pushed). Not a status
   * transition, so it doesn't go through ALLOWED_TRANSITIONS; instead it's
   * blocked once the order has reached a state where delivery timing is
   * no longer meaningful to change.
   */
  async rescheduleDelivery(orderId, { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, reason }, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const TERMINAL_STATUSES = new Set(['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUNDED'])
    if (TERMINAL_STATUSES.has(order.status)) {
      throw {
        statusCode: 400,
        message: `Cannot reschedule delivery for an order that is ${order.status}`,
      }
    }

    const before = {
      deliveryMode: order.delivery_mode,
      scheduledSlotStart: order.scheduled_slot_start,
      scheduledSlotEnd: order.scheduled_slot_end,
      scheduledSlotLabel: order.scheduled_slot_label,
    }

    const updated = await this.repository.rescheduleDelivery(orderId, {
      scheduledSlotStart,
      scheduledSlotEnd,
      scheduledSlotLabel,
    })

    logAdminActivity(
      adminId,
      `Order delivery rescheduled${reason ? `: ${reason}` : ''}`,
      'order',
      orderId,
      before,
      { deliveryMode: 'SCHEDULED', scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel },
      ip
    )

    await notificationQueue.add('order-rescheduled', {
      orderId,
      userId: order.user_id,
      orderNumber: order.order_number,
      scheduledSlotLabel,
    })

    this._emitOrderStatus(order, order.status) // status unchanged — just refresh delivery info

    return updated
  }

  async assignRider(orderId, riderId, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const assignment = await this.repository.assignRider(orderId, riderId)

    logAdminActivity(adminId, `Assigned rider to order`, 'order', orderId,
      { rider_id: order.rider_id }, { rider_id: riderId }, ip)

    await notificationQueue.add('rider-assigned', {
      orderId, riderId, orderNumber: order.order_number,
    })

    this._emitAssignedOrder(order, riderId)

    return { orderId, riderId }
  }

  async bulkAssign(assignments, adminId, ip) {
    if (assignments.length > 50) throw { statusCode: 400, message: 'Max 50 assignments at once' }
    const results = await this.repository.bulkAssign(assignments)
    logAdminActivity(adminId, `Bulk assigned ${assignments.length} orders`, 'order', null, null,
      { count: assignments.length }, ip)

    for (const result of results) {
      await notificationQueue.add('rider-assigned', {
        orderId: result.orderId,
        riderId: result.riderId,
      })

      const order = await this.repository.findById(result.orderId)
      if (order) {
        this._emitAssignedOrder(order, result.riderId)
      }
    }

    return results
  }

  async createManualOrder(data, adminId, ip) {
    const order = await this.repository.createManualOrder({ ...data, adminId })
    logAdminActivity(adminId, `Created manual order ${order.order_number}`, 'order', order.id,
      null, { order_number: order.order_number, total: order.total_amount }, ip)
    if (!order.rider_id && ASSIGNABLE_ORDER_STATUSES.has(order.status)) {
      await this._queueAutoAssign(order.id, 'ADMIN_MANUAL_ORDER')
    }
    return order
  }

  async getInvoice(orderId) {
    const order = await this.findById(orderId)
    return generateInvoicePDF(order)
  }

  async getPackingSlip(orderId) {
    const order = await this.findById(orderId)
    // Simplified packing slip — just items + customer info (no pricing)
    return {
      order_number: order.order_number, customer: order.customer_name,
      address: order.delivery_address, items: order.items.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit }))
    }
  }

  async exportCSV(filters) {
    const orders = await this.repository.getOrdersForExport(filters)
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Orders')

    sheet.columns = [
      { header: 'Order Number', key: 'order_number', width: 20 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Total (₹)', key: 'total_amount', width: 12 },
      { header: 'Payment', key: 'payment_method', width: 12 },
      { header: 'Payment Status', key: 'payment_status', width: 15 },
      { header: 'Customer', key: 'customer', width: 25 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'City', key: 'city', width: 15 },
      { header: 'Date', key: 'created_at', width: 22 },
    ]

    orders.forEach(o => sheet.addRow(o))

    return workbook.csv.writeBuffer()
  }

  /**
   * Refund a delivered/cancelled order. The refund amount is never
   * caller-supplied — it's always exactly what the customer actually paid
   * (from the `payments` row for online orders, or `total_amount` for a
   * COD order marked PAID on delivery — see `delivery.repository.js`'s
   * `payment_status = 'PAID'` write, the single source of truth for
   * "money actually changed hands" across both payment methods). An order
   * that was never paid (e.g. a COD order cancelled before delivery) has
   * nothing to refund and is rejected outright.
   */
  async refundOrder(orderId, { reason, refundTo = 'wallet' }, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    // Only delivered or cancelled orders can be refunded
    if (!['DELIVERED', 'CANCELLED'].includes(order.status)) {
      throw { statusCode: 400, message: `Cannot refund an order with status ${order.status}` }
    }

    if (order.payment_status !== 'PAID') {
      throw { statusCode: 400, message: 'This order was never paid — there is nothing to refund' }
    }

    const payment = await this.repository.getOrderPayment(orderId)
    const paidAmount = payment ? parseFloat(payment.amount) : parseFloat(order.total_amount)
    const hasGatewayPayment = !!(payment && payment.status === 'PAID' && payment.razorpay_payment_id)
    const refundAmount = refundTo === 'none' ? 0 : paidAmount

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
        reason: reason || `Refund for order ${order.order_number}`,
      })
      if (!result.success) {
        throw { statusCode: 400, message: result.message || 'Refund failed' }
      }
    } else if (refundTo === 'wallet') {
      const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
      const customersRepo = new AdminCustomersRepository()
      await customersRepo.creditWallet(
        order.user_id,
        refundAmount,
        reason || `Refund for order ${order.order_number}`
      )
    }
    // refundTo === 'none' moves no money — order still gets marked
    // REFUNDED below so it's recorded as closed-out, just with ₹0 back.

    // Update order status to REFUNDED (also true when PaymentsService.refund
    // already flipped it — this call is idempotent and adds the
    // admin-attributed order_status_history row for the audit trail).
    const oldStatus = await this.repository.updateStatus(orderId, 'REFUNDED', adminId, reason || 'Refund issued')

    logAdminActivity(
      adminId,
      `Refund ₹${refundAmount} (${refundTo}) for order ${order.order_number}`,
      'order', orderId,
      { status: oldStatus }, { status: 'REFUNDED', refundTo, refundAmount },
      ip
    )

    const refundDestination = refundTo === 'original' ? 'original payment method' : 'wallet'
    await this._queueNotification(order.user_id, {
      title: '💰 Refund processed',
      body: refundAmount > 0
        ? `₹${refundAmount} has been refunded to your ${refundDestination} for order ${order.order_number}.`
        : `Your refund for order ${order.order_number} has been processed.`,
      type: 'ORDER_STATUS',
      data: {
        type: 'ORDER_STATUS', orderId, orderNumber: order.order_number,
        timelineType: 'REFUNDED', status: 'REFUNDED', refundAmount, refundTo,
      },
    })

    return { orderId, refundAmount, refundTo, status: 'REFUNDED' }
  }

  async cancelOrder(orderId, body, adminId, ip) {
    const { reason, refundTo } = body || {}
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    // Treat null status as PENDING
    const currentStatus = order.status || 'PENDING'
    const allowed = ALLOWED_TRANSITIONS[currentStatus]
    if (!allowed || !allowed.includes('CANCELLED')) {
      throw { statusCode: 400, message: `Cannot cancel an order with status ${currentStatus}` }
    }

    // Cancel the order
    const oldStatus = await this.repository.updateStatus(orderId, 'CANCELLED', adminId, reason || 'Cancelled by admin')

    // Refund only makes sense once money has actually changed hands — most
    // cancellations happen on PENDING/CONFIRMED orders that were never
    // paid (COD, or an online order cancelled before capture), so skip any
    // money movement unless payment_status is actually PAID. Mirrors the
    // same gate as `refundOrder`.
    let refundAmount = 0
    let appliedRefundTo = 'none'
    if (refundTo && refundTo !== 'none' && order.payment_status === 'PAID') {
      const payment = await this.repository.getOrderPayment(orderId)
      const paidAmount = payment ? parseFloat(payment.amount) : parseFloat(order.total_amount)
      const hasGatewayPayment = !!(payment && payment.status === 'PAID' && payment.razorpay_payment_id)

      if (refundTo === 'original' && hasGatewayPayment) {
        const { PaymentsService } = await import('../../payments/payments.service.js')
        const { PaymentsRepository } = await import('../../payments/payments.repository.js')
        const result = await new PaymentsService(new PaymentsRepository()).refund(payment.id, {
          reason: reason || `Refund for cancelled order ${order.order_number}`,
        })
        if (result.success) {
          refundAmount = paidAmount
          appliedRefundTo = 'original'
        }
      } else {
        // 'wallet', or 'original' requested but no gateway payment on file
        // (e.g. COD collected then cancelled) — fall back to wallet credit
        // rather than silently doing nothing.
        const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
        const customersRepo = new AdminCustomersRepository()
        await customersRepo.creditWallet(
          order.user_id,
          paidAmount,
          reason || `Refund for cancelled order ${order.order_number}`
        )
        refundAmount = paidAmount
        appliedRefundTo = 'wallet'
      }
    }

    logAdminActivity(
      adminId,
      `Cancelled order ${order.order_number}${refundAmount > 0 ? ` (refunded ₹${refundAmount} via ${appliedRefundTo})` : ''}`,
      'order', orderId,
      { status: oldStatus }, { status: 'CANCELLED', refundTo: appliedRefundTo, refundAmount },
      ip
    )

    await this._queueNotification(order.user_id, buildCustomerOrderEventNotification({
      orderId, orderNumber: order.order_number, timelineType: 'CANCELLED', status: 'CANCELLED',
    }))

    if (refundAmount > 0) {
      const refundDestination = appliedRefundTo === 'original' ? 'original payment method' : 'wallet'
      await this._queueNotification(order.user_id, {
        title: '💰 Refund processed',
        body: `₹${refundAmount} has been refunded to your ${refundDestination} for order ${order.order_number}.`,
        type: 'ORDER_STATUS',
        data: {
          type: 'ORDER_STATUS', orderId, orderNumber: order.order_number,
          timelineType: 'REFUNDED', status: 'REFUNDED', refundAmount, refundTo: appliedRefundTo,
        },
      })
    }

    return { orderId, status: 'CANCELLED', refundAmount, refundTo: appliedRefundTo }
  }

  async bulkUpdateStatus(orderIds, newStatus, adminId, ip) {
    const results = []
    for (const orderId of orderIds) {
      try {
        const res = await this.updateStatus(orderId, newStatus, adminId, null, ip)
        results.push({ orderId, ...res, success: true })
      } catch (err) {
        results.push({ orderId, success: false, message: err.message || 'Failed' })
      }
    }
    return { updated: results.filter(r => r.success).length, results }
  }

  async _emitAssignedOrder(order, riderId) {
    try {
      if (!this.fastify?.emitOrderAssignedToRider) {
        return
      }

      // Get store location from app_settings (not hardcoded)
      let storeLat = 0, storeLng = 0
      let storeName = 'Bakaloo Store', storeAddr = 'Pickup location', storePhone = ''
      try {
        const { rows } = await dbQuery(
          `SELECT key, value FROM app_settings WHERE key IN ('store_lat', 'store_lng', 'store_name', 'store_address', 'store_phone')`
        )
        for (const row of rows) {
          const val = typeof row.value === 'string' ? row.value.replace(/^"|"$/g, '') : String(row.value)
          switch (row.key) {
            case 'store_lat': storeLat = parseFloat(val) || 0; break
            case 'store_lng': storeLng = parseFloat(val) || 0; break
            case 'store_name': storeName = val; break
            case 'store_address': storeAddr = val; break
            case 'store_phone': storePhone = val; break
          }
        }
      } catch (_) { /* use defaults if settings not found */ }

      const address = this._parseAddress(order.delivery_address)
      const riderEarning = parseFloat(order.delivery_fee || 25)
      this.fastify.emitOrderAssignedToRider(riderId, {
        orderId: order.id,
        orderNumber: order.order_number,
        status: 'ASSIGNED',
        totalAmount: parseFloat(order.total_amount || 0),
        paymentMethod: order.payment_method || 'ONLINE',
        estimatedDistance: 0,
        estimatedDuration: 0,
        riderEarning,
        offerTimeoutSeconds: 0,
        offerExpiresAt: null,
        isOfferActive: true,
        items: this._parseItems(order.items),
        customerAddress: {
          name: order.customer_name || address.name || 'Customer',
          address: address.address || address.fullAddress || 'Delivery address unavailable',
          landmark: address.landmark || '',
          phone: order.customer_phone || address.phone || '',
          lat: address.lat ?? address.latitude ?? 0,
          lng: address.lng ?? address.longitude ?? 0,
        },
        storeAddress: {
          name: storeName,
          address: storeAddr,
          landmark: '',
          phone: storePhone,
          lat: storeLat,
          lng: storeLng,
        },
      })
    } catch (_) {
      // Keep admin assignment non-blocking if realtime emit fails.
    }
  }

  /**
   * Keep admin flow aligned with worker-based auto-assign.
   */
  async _autoAssignRider(orderId, _order) {
    await this._queueAutoAssign(orderId, 'ADMIN_FALLBACK')
  }

  async _queueAutoAssign(orderId, source) {
    try {
      await orderQueue.add(
        'auto-assign',
        { type: 'auto-assign', orderId, source },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      console.warn('Auto-assign queue failed, running inline fallback:', err?.message || err)
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
    } catch (fallbackErr) {
      console.error('Inline auto-assign fallback failed:', fallbackErr?.message || fallbackErr)
    }
  }

  _emitOrderStatus(order, status) {
    try {
      if (!this.fastify?.emitOrderUpdate) {
        return
      }

      const userIds = [order.user_id, order.rider_id].filter(Boolean)
      this.fastify.emitOrderUpdate(order.id, userIds, {
        orderId: order.id,
        orderNumber: order.order_number,
        status,
        message: this._statusMessage(status),
      })
    } catch (_) {
      // Keep admin status updates non-blocking if realtime emit fails.
    }
  }

  _statusMessage(status) {
    const messages = {
      CANCELLED: 'Order cancelled by support',
      OUT_FOR_DELIVERY: 'Order is now out for delivery',
      DELIVERED: 'Order delivered successfully',
    }

    return messages[status] || `Order updated to ${status}`
  }

  _parseAddress(value) {
    if (!value) return {}
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch (_) {
        return { address: value }
      }
    }
    return value
  }

  _parseItems(value) {
    if (!value) return []
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch (_) {
        return []
      }
    }
    return []
  }
}
