import { getClient } from '../../config/database.js'
import { orderQueue } from '../../config/bullmq.js'
import { logger } from '../../config/logger.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { ORDER_STATUS, ACTIVE_ORDER_STATUSES } from '../../constants/orderStatus.js'
import { generateInvoicePDF } from '../../utils/invoiceGenerator.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { buildCustomerOrderEventNotification } from '../notifications/customer-order-event.helper.js'

// Lazy-loaded collaborator instances (avoids circular imports)
import { CartRepository } from '../cart/cart.repository.js'
import { CartService } from '../cart/cart.service.js'
import { AddressesRepository } from '../addresses/addresses.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'
import { CouponsService } from '../coupons/coupons.service.js'

const DELIVERY_FEE = 25 // ₹25 flat delivery fee
const PLATFORM_FEE = 5 // ₹5 platform fee
const FREE_DELIVERY_THRESHOLD = 499 // Free delivery above ₹499
const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Orders service — business logic for order placement & management
 */
export class OrdersService {
  constructor(repository, fastify = null) {
    this.repo = repository
    this.fastify = fastify

    // Collaborators
    this.cartRepo = new CartRepository()
    this.cartService = new CartService(this.cartRepo)
    this.addressRepo = new AddressesRepository()
    this.couponsRepo = new CouponsRepository()
    this.couponsService = new CouponsService(this.couponsRepo)
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
  }

  /**
   * Place a new order
   * 1. Validate cart (stock + prices)
   * 2. Validate delivery address
   * 3. Apply coupon (optional)
   * 4. Calculate totals
   * 5. Create order + decrement stock (transaction)
   * 6. Clear cart
   * 7. Record coupon usage
   */
  async placeOrder(userId, body) {
    const {
      addressId,
      paymentMethod,
      couponCode,
      deliveryNotes,
      tipAmount,
      deliveryInstructions,
      handlingFee,
      lateNightFee,
      savingsTotal,
    } = body

    // 1. Validate cart
    const cartResult = await this.cartService.validateCart(userId)
    if (!cartResult.valid || cartResult.items.length === 0) {
      return {
        success: false,
        message: cartResult.warnings?.length
          ? cartResult.warnings.join('; ')
          : 'Cart is empty or has issues',
      }
    }

    const { items: cartItems, subtotal } = cartResult

    // 2. Validate delivery address
    const address = await this.addressRepo.findByIdAndUser(addressId, userId)
    if (!address) {
      return { success: false, message: 'Delivery address not found' }
    }
    const addressLat = Number(address.lat)
    const addressLng = Number(address.lng)
    if (!Number.isFinite(addressLat) || !Number.isFinite(addressLng)) {
      return {
        success: false,
        message: 'Selected address is missing map pin. Please update address location.',
        code: 'ADDRESS_COORDINATES_REQUIRED',
      }
    }
    const deliveryAddress = {
      ...address,
      lat: addressLat,
      lng: addressLng,
    }

    // 3. Apply coupon (optional)
    let discountAmount = 0
    let appliedCouponCode = null

    if (couponCode) {
      const couponResult = await this.couponsService.validate(userId, couponCode, subtotal)
      if (!couponResult.valid) {
        return { success: false, message: couponResult.message }
      }
      discountAmount = couponResult.discount
      appliedCouponCode = couponResult.code
    }

    // 4. Calculate totals
    const hasTipAmount = Object.prototype.hasOwnProperty.call(body, 'tipAmount')
    const normalizedInstructions = typeof deliveryInstructions === 'string'
      ? deliveryInstructions.trim()
      : deliveryInstructions

    const [tipFromRedis, instructionsFromRedis] = await Promise.all([
      hasTipAmount ? Promise.resolve(0) : this.cartRepo.getTip(userId),
      normalizedInstructions ? Promise.resolve(null) : this.cartRepo.getInstructions(userId),
    ])

    const deliveryFee = subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE
    const platformFee = PLATFORM_FEE
    const taxAmount = 0 // Tax included in product price for MVP
    const orderHandlingFee = this._toNumber(handlingFee)
    const orderLateNightFee = this._toNumber(lateNightFee)
    const orderTipAmount = hasTipAmount
      ? this._toNumber(tipAmount)
      : this._toNumber(tipFromRedis)
    const resolvedInstructions = normalizedInstructions || instructionsFromRedis || null
    const orderSavingsTotal = this._toNumber(savingsTotal)
    const totalAmount = parseFloat(
      (subtotal - discountAmount + deliveryFee + platformFee + taxAmount + orderHandlingFee + orderLateNightFee + orderTipAmount).toFixed(2)
    )

    // 5. Build order items snapshot
    const orderItems = cartItems.map((item) => ({
      productId: item.productId,
      name: item.name,
      price: parseFloat(item.salePrice ?? item.price),
      quantity: item.quantity,
      unit: item.unit,
      total: item.lineTotal,
    }))

    // 6. Generate order number
    const orderNumber = await this.repo.generateOrderNumber()

    // Estimate delivery: 30 minutes from now
    const estimatedDelivery = new Date(Date.now() + 30 * 60 * 1000)

    const normalizedPaymentMethod = `${paymentMethod || 'COD'}`.toUpperCase()
    const initialStatus = normalizedPaymentMethod === 'COD'
      ? ORDER_STATUS.CONFIRMED
      : ORDER_STATUS.PENDING

    // 7. Transaction: create order + decrement stock
    const client = await getClient()
    let order

    try {
      await client.query('BEGIN')

      order = await this.repo.create(
        client,
        {
          orderNumber,
          userId,
          status: initialStatus,
          items: orderItems,
          subtotal,
          discountAmount,
          deliveryFee,
          platformFee,
          taxAmount,
          totalAmount,
          paymentMethod: normalizedPaymentMethod,
          paymentStatus: 'PENDING',
          couponCode: appliedCouponCode,
          deliveryAddress,
          deliveryNotes: deliveryNotes || null,
          estimatedDelivery,
          handlingFee: orderHandlingFee,
          lateNightFee: orderLateNightFee,
          tipAmount: orderTipAmount,
          deliveryInstructions: resolvedInstructions,
          savingsTotal: orderSavingsTotal,
        },
        orderItems
      )

      await this.repo.decrementStock(client, orderItems)

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId }, 'Order placement failed')
      return { success: false, message: err.message || 'Failed to place order' }
    } finally {
      client.release()
    }

    // 8. Post-transaction: clear cart + record coupon
    try {
      await Promise.all([
        this.cartService.clearCart(userId),
        this.cartRepo.clearTip(userId),
        this.cartRepo.clearInstructions(userId),
      ])

      if (appliedCouponCode) {
        await this.couponsService.recordUsage(appliedCouponCode, userId, order.id)
      }
    } catch (err) {
      // Non-critical — order is already placed
      logger.warn({ err, orderId: order.id }, 'Post-order cleanup partial failure')
    }

    logger.info(
      {
        orderId: order.id,
        orderNumber,
        userId,
        total: totalAmount,
        paymentMethod: normalizedPaymentMethod,
        status: initialStatus,
      },
      'Order placed successfully'
    )

    await this._sendCustomerOrderNotification(
      userId,
      buildCustomerOrderEventNotification({
        orderId: order.id,
        orderNumber,
        timelineType: 'ORDER_PLACED',
        status: initialStatus,
      })
    )

    if (initialStatus === ORDER_STATUS.CONFIRMED) {
      await this._queueAutoAssign(order.id, 'ORDER_PLACED_COD')
    }

    return { success: true, order }
  }

  _toNumber(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  /**
   * List orders for the current user (paginated)
   */
  async listByUser(userId, filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { orders, total } = await this.repo.findByUser(userId, {
      limit,
      offset,
      status: filters.status,
    })

    return {
      orders,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Get active (in-progress) order for a user
   */
  async getActive(userId) {
    const order = await this.repo.findActiveByUser(userId)
    if (!order) {
      return null
    }
    return this._enrichCustomerOrder(order)
  }

  /**
   * Get a single order by ID (user-scoped)
   */
  async getById(userId, orderId) {
    const order = await this.repo.findByIdAndUser(orderId, userId)
    if (!order) {
      return null
    }
    return this._enrichCustomerOrder(order)
  }

  /**
   * Cancel an order (only if PENDING or CONFIRMED)
   */
  async cancel(userId, orderId, reason) {
    const order = await this.repo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    const cancellable = [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED]
    if (!cancellable.includes(order.status)) {
      return {
        success: false,
        message: `Cannot cancel order in "${order.status}" status`,
      }
    }

    // Restore stock in a transaction
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await this.repo.restoreStock(client, order.items)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, orderId }, 'Stock restore failed during cancellation')
    } finally {
      client.release()
    }

    const updated = await this.repo.updateStatus(orderId, ORDER_STATUS.CANCELLED, {
      cancelledReason: reason || 'Cancelled by customer',
    })

    logger.info({ orderId, userId }, 'Order cancelled')
    return { success: true, order: updated }
  }

  /**
   * Re-order: add items from a past order back to cart
   */
  async reorder(userId, orderId) {
    const order = await this.repo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    const warnings = []

    for (const item of order.items) {
      const result = await this.cartService.addItem(userId, {
        productId: item.productId,
        quantity: item.quantity,
      })
      if (!result.success) {
        warnings.push(result.message)
      }
    }

    const cart = await this.cartService.getCart(userId)

    return {
      success: true,
      cart,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  // ─── Admin methods ─────────────────────────────────────

  /**
   * Admin: list all orders (paginated, filterable)
   */
  async adminListAll(filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { orders, total } = await this.repo.findAll({
      limit,
      offset,
      status: filters.status,
      userId: filters.userId,
    })

    return {
      orders,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Admin: update order status
   */
  async adminUpdateStatus(orderId, status) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    const extra = {}
    if (status === ORDER_STATUS.DELIVERED) {
      extra.deliveredAt = new Date()
      extra.paymentStatus = 'PAID'
    }
    if (status === ORDER_STATUS.CANCELLED) {
      extra.cancelledReason = 'Cancelled by admin'
      // Restore stock
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await this.repo.restoreStock(client, order.items)
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error({ err, orderId }, 'Stock restore failed during admin cancellation')
      } finally {
        client.release()
      }
    }

    const updated = await this.repo.updateStatus(orderId, status, extra)
    logger.info({ orderId, status }, 'Order status updated by admin')
    return { success: true, order: updated }
  }

  /**
   * Admin: assign a rider to an order
   */
  async adminAssignRider(orderId, riderId) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    if (order.status === ORDER_STATUS.DELIVERED || order.status === ORDER_STATUS.CANCELLED) {
      return { success: false, message: 'Cannot assign rider to a completed/cancelled order' }
    }

    const updated = await this.repo.assignRider(orderId, riderId)
    logger.info({ orderId, riderId }, 'Rider assigned to order')
    return { success: true, order: updated }
  }

  /**
   * Generate PDF invoice for an order
   */
  async getInvoice(userId, orderId) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, statusCode: 404, message: 'Order not found' }
    }

    // Customers can only access their own invoices
    if (order.user_id !== userId) {
      return { success: false, statusCode: 403, message: 'Access denied' }
    }

    if (order.payment_status !== 'PAID') {
      return { success: false, statusCode: 400, message: 'Invoice available only for paid orders' }
    }

    const buffer = await generateInvoicePDF(order)
    return {
      success: true,
      buffer,
      orderNumber: order.order_number,
    }
  }

  async _queueAutoAssign(orderId, source = 'ORDERS_SERVICE') {
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

  async _enrichCustomerOrder(order) {
    const [statusHistory, riderLocation] = await Promise.all([
      this.repo.getStatusHistory(order.id),
      order.riderId && this.fastify?.getRiderLocation
        ? this.fastify.getRiderLocation(order.riderId).catch(() => null)
        : Promise.resolve(null),
    ])

    return {
      ...order,
      timeline: this._buildCustomerTimeline(order, statusHistory || []),
      tracking: this._buildTrackingData(order, riderLocation),
    }
  }

  _buildCustomerTimeline(order, statusHistory) {
    const timeline = [
      {
        type: 'PENDING',
        status: 'PENDING',
        message: 'Order placed',
        timestamp: order.createdAt,
      },
    ]
    const seenTypes = new Set(['PENDING'])

    for (const entry of statusHistory) {
      const timelineType = this._normalizeTimelineType(entry.to_status)
      if (!timelineType || seenTypes.has(timelineType)) {
        continue
      }

      timeline.push({
        type: timelineType,
        status: this._timelineTypeToOrderStatus(timelineType),
        message: entry.note || this._timelineMessage(timelineType),
        timestamp: entry.changed_at,
      })
      seenTypes.add(timelineType)
    }

    const currentTimelineType = this._normalizeTimelineType(order.status)
    if (currentTimelineType && !seenTypes.has(currentTimelineType)) {
      timeline.push({
        type: currentTimelineType,
        status: this._timelineTypeToOrderStatus(currentTimelineType),
        message: this._timelineMessage(currentTimelineType),
        timestamp: order.deliveredAt || order.updatedAt || order.createdAt,
      })
    }

    return timeline.sort((left, right) => {
      const leftTime = new Date(left.timestamp).getTime()
      const rightTime = new Date(right.timestamp).getTime()
      return leftTime - rightTime
    })
  }

  _buildTrackingData(order, riderLocation) {
    const address = order.deliveryAddress || {}
    const destinationLat = Number(address.lat)
    const destinationLng = Number(address.lng)
    const riderLat = Number(riderLocation?.lat)
    const riderLng = Number(riderLocation?.lng)

    return {
      rider: order.riderId
        ? {
            id: order.riderId,
            name: order.riderName || 'Delivery partner',
            phone: order.riderPhone || '',
          }
        : null,
      riderLocation:
        Number.isFinite(riderLat) && Number.isFinite(riderLng)
          ? {
              lat: riderLat,
              lng: riderLng,
              timestamp: riderLocation?.updatedAt
                ? new Date(riderLocation.updatedAt).toISOString()
                : null,
            }
          : null,
      destination: {
        lat: Number.isFinite(destinationLat) ? destinationLat : null,
        lng: Number.isFinite(destinationLng) ? destinationLng : null,
        addressLine1: address.addressLine1 || address.address_line1 || '',
        addressLine2: address.addressLine2 || address.address_line2 || '',
        landmark: address.landmark || '',
        city: address.city || '',
        state: address.state || '',
        pincode: address.pincode || '',
      },
    }
  }

  _normalizeTimelineType(rawStatus) {
    const normalized = `${rawStatus || ''}`.trim().toUpperCase()
    if (!normalized) {
      return null
    }

    if (normalized === 'IN_TRANSIT') {
      return 'OUT_FOR_DELIVERY'
    }

    return normalized
  }

  _timelineTypeToOrderStatus(timelineType) {
    switch (timelineType) {
      case 'RIDER_ACCEPTED':
        return 'PACKED'
      case 'PICKED_UP':
      case 'OUT_FOR_DELIVERY':
        return 'OUT_FOR_DELIVERY'
      default:
        return timelineType
    }
  }

  _timelineMessage(timelineType) {
    switch (timelineType) {
      case 'PENDING':
        return 'Order placed'
      case 'CONFIRMED':
        return 'Store accepted your order'
      case 'PREPARING':
        return 'Store is preparing your order'
      case 'PACKED':
        return 'Order packed and ready for pickup'
      case 'RIDER_ACCEPTED':
        return 'Delivery partner accepted your order'
      case 'PICKED_UP':
        return 'Delivery partner picked up your order'
      case 'OUT_FOR_DELIVERY':
        return 'Your order is out for delivery'
      case 'DELIVERED':
        return 'Order delivered successfully'
      case 'CANCELLED':
        return 'Order cancelled'
      default:
        return 'Order updated'
    }
  }

  async _sendCustomerOrderNotification(userId, notification) {
    if (!this.notificationsService || !userId || !notification) {
      return
    }

    try {
      await this.notificationsService.sendNotification(userId, notification)
    } catch (err) {
      logger.warn(
        {
          err: err.message,
          userId,
          orderId: notification?.data?.orderId ?? null,
          timelineType: notification?.data?.timelineType ?? null,
        },
        'Customer order notification failed'
      )
    }
  }
}
