import { getClient } from '../../config/database.js'
import { query } from '../../config/database.js'
import { orderQueue } from '../../config/bullmq.js'
import { logger } from '../../config/logger.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { ORDER_STATUS, ACTIVE_ORDER_STATUSES } from '../../constants/orderStatus.js'
import { generateInvoicePDF } from '../../utils/invoiceGenerator.js'
import { normalizeCloudinaryDeliveryUrl } from '../../config/cloudinary.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { buildCustomerOrderEventNotification } from '../notifications/customer-order-event.helper.js'

// Lazy-loaded collaborator instances (avoids circular imports)
import { CartRepository } from '../cart/cart.repository.js'
import { CartService } from '../cart/cart.service.js'
import { AddressesRepository } from '../addresses/addresses.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'
import { CouponsService } from '../coupons/coupons.service.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'
import { ShopProductsService } from '../shop-products/shop-products.service.js'
import { OrderSplitterService } from './order-splitter.service.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { TotalsEngine } from '../cart/totals-engine.service.js'

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
  constructor(repository, fastify = null, options = {}) {
    this.repo = repository
    this.fastify = fastify

    // Collaborators
    this.cartRepo = options.cartRepository || new CartRepository()
    this.cartService = options.cartService || new CartService(this.cartRepo)
    this.addressRepo = options.addressesRepository || new AddressesRepository()
    this.couponsRepo = options.couponsRepository || new CouponsRepository()
    this.couponsService =
      options.couponsService || new CouponsService(this.couponsRepo)
    this.shopProductsRepo =
      options.shopProductsRepository || new ShopProductsRepository()
    // Build a ShopProductsService for stock-transition side effects so that
    // order-driven stock decrements (Req 11.1–11.4, 11.6, 11.9) emit the
    // same Socket.IO + push notifications as manual stock updates.
    this.shopProductsService =
      options.shopProductsService ||
      new ShopProductsService(this.shopProductsRepo, {
        notificationsService: fastify
          ? new NotificationsService(new NotificationsRepository(), fastify)
          : null,
      })
    // Canonical fee engine — shared by cart summary and order creation so
    // the charged total always matches the displayed bill.
    this.feeSettingsService =
      options.feeSettingsService || new FeeSettingsService()
    this.totalsEngine =
      options.totalsEngine ||
      new TotalsEngine({ feeSettingsService: this.feeSettingsService })
    this.orderSplitter =
      options.orderSplitter ||
      new OrderSplitterService({
        ordersRepository: this.repo,
        shopProductsRepository: this.shopProductsRepo,
        shopProductsService: this.shopProductsService,
        feeSettingsService: this.feeSettingsService,
        totalsEngine: this.totalsEngine,
        fees: {
          deliveryFee: DELIVERY_FEE,
          platformFee: PLATFORM_FEE,
          freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
        },
      })
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
  }

  /**
   * Place a multi-vendor order from the cart.
   *
   * Flow:
   *   1. Re-validate cart against current allocations + max_order_qty + stock
   *      (Requirements 12.3, 12.7). Any failure short-circuits with code
   *      CHECKOUT_PARTIAL_FAIL listing each `{ productId, shopId, reason }`.
   *   2. Validate the delivery address has coordinates.
   *   3. Open a single pg transaction.
   *   4. Delegate to OrderSplitter which:
   *        - groups items by shop_id (Req 5.6)
   *        - locks shop_products rows (SELECT FOR UPDATE) (Req 11.7)
   *        - re-checks max_order_qty + stock under the lock (Req 12.7)
   *        - decrements stock and inserts one order per shop with
   *          independently-computed fees (Req 5.7)
   *   5. COMMIT on success; ROLLBACK on any error (Req 5.9, 15.9, 15.10).
   *   6. Post-commit: clear cart + extras, enqueue per-order delivery
   *      assignments, and send customer notifications (Req 5.8).
   *
   * Coupons and tip are applied ONLY when the cart resolves to a single
   * shop. With multi-shop carts they are deferred to a later spec — applying
   * a single coupon code across multiple per-shop totals would require
   * platform-level coupon redistribution rules that are out of scope.
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
      // Delivery slot fields
      deliveryMode,
      scheduledDeliveryAt,
      scheduledSlotStart,
      scheduledSlotEnd,
      scheduledSlotLabel,
    } = body

    // Validate delivery slot
    const resolvedDeliveryMode = (deliveryMode || 'ASAP').toUpperCase()
    if (!['ASAP', 'SCHEDULED'].includes(resolvedDeliveryMode)) {
      return {
        success: false,
        message: 'deliveryMode must be ASAP or SCHEDULED',
        code: 'INVALID_DELIVERY_MODE',
      }
    }
    if (resolvedDeliveryMode === 'SCHEDULED') {
      if (!scheduledSlotStart || !scheduledSlotEnd) {
        return {
          success: false,
          message: 'scheduledSlotStart and scheduledSlotEnd are required for SCHEDULED delivery',
          code: 'MISSING_SLOT_FIELDS',
        }
      }
      const slotStart = new Date(scheduledSlotStart)
      const slotEnd = new Date(scheduledSlotEnd)
      const now = new Date()
      if (!Number.isFinite(slotStart.getTime()) || !Number.isFinite(slotEnd.getTime())) {
        return {
          success: false,
          message: 'scheduledSlotStart and scheduledSlotEnd must be valid ISO timestamps',
          code: 'INVALID_SLOT_TIMESTAMPS',
        }
      }
      if (slotStart <= now) {
        return {
          success: false,
          message: 'Scheduled delivery time must be in the future',
          code: 'SLOT_IN_PAST',
        }
      }
      if (slotEnd <= slotStart) {
        return {
          success: false,
          message: 'Slot end time must be after slot start time',
          code: 'INVALID_SLOT_RANGE',
        }
      }
      // Max 7 days ahead
      const maxAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      if (slotStart > maxAhead) {
        return {
          success: false,
          message: 'Scheduled delivery cannot be more than 7 days in the future',
          code: 'SLOT_TOO_FAR_AHEAD',
        }
      }
    }

    // 1. Validate cart (re-checks allocations, shop active, stock,
    //    max_order_qty per Req 12.3/12.7)
    const cartResult = await this.cartService.validateCart(userId)
    if (!cartResult.valid || cartResult.items.length === 0) {
      const failed = cartResult.failed && cartResult.failed.length > 0
        ? cartResult.failed
        : []
      const message = failed.length > 0
        ? 'Some items in your cart cannot be ordered right now'
        : (cartResult.warnings && cartResult.warnings[0]) || 'Cart is empty'
      return {
        success: false,
        message,
        code: failed.length > 0 ? 'CHECKOUT_PARTIAL_FAIL' : 'EMPTY_CART',
        failures: failed,
      }
    }

    const { items: cartItems, subtotal, groupedByShop } = cartResult

    // 2. Validate delivery address
    const address = await this.addressRepo.findByIdAndUser(addressId, userId)
    if (!address) {
      return { success: false, message: 'Delivery address not found', code: 'ADDRESS_NOT_FOUND' }
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

    // 3. Apply coupon — only meaningful when the cart is single-shop. For
    //    multi-shop carts coupons are deferred (see method docstring).
    let appliedCouponCode = null
    let appliedCouponDiscount = 0
    let couponShopId = null
    if (couponCode) {
      const isSingleShop = groupedByShop.size === 1
      if (!isSingleShop) {
        return {
          success: false,
          message: 'Coupons are not yet supported for multi-shop carts',
          code: 'COUPON_MULTI_SHOP_UNSUPPORTED',
        }
      }
      const couponResult = await this.couponsService.validate(userId, couponCode, subtotal)
      if (!couponResult.valid) {
        return { success: false, message: couponResult.message, code: 'INVALID_COUPON' }
      }
      appliedCouponCode = couponResult.code
      // Capture the discount amount so it is actually deducted from the order
      // total (previously the code was stored but the discount was dropped).
      appliedCouponDiscount = Number(couponResult.discount || 0)
      couponShopId = Array.from(groupedByShop.keys())[0]
    }

    // 4. Resolve checkout extras (tip / instructions) — preserves the
    //    pre-multi-vendor behaviour for single-shop carts.
    const hasTipAmount = Object.prototype.hasOwnProperty.call(body, 'tipAmount')
    const normalizedInstructions = typeof deliveryInstructions === 'string'
      ? deliveryInstructions.trim()
      : deliveryInstructions
    const [tipFromRedis, instructionsFromRedis] = await Promise.all([
      hasTipAmount ? Promise.resolve(0) : this.cartRepo.getTip(userId),
      normalizedInstructions ? Promise.resolve(null) : this.cartRepo.getInstructions(userId),
    ])
    const orderTipAmount = hasTipAmount
      ? this._toNumber(tipAmount)
      : this._toNumber(tipFromRedis)
    const resolvedInstructions = normalizedInstructions || instructionsFromRedis || null

    const normalizedPaymentMethod = `${paymentMethod || 'COD'}`.toUpperCase()
    const initialPaymentStatus = 'PENDING'

    // Resolve shop coordinates for distance-based delivery fees (one query
    // for every shop in the cart). Used by the splitter's fee engine.
    const shopCoords = new Map()
    try {
      const shopIdList = Array.from(groupedByShop.keys())
      if (shopIdList.length > 0) {
        const { rows } = await query(
          `SELECT id, name, lat, lng FROM shops WHERE id = ANY($1)`,
          [shopIdList]
        )
        for (const r of rows) {
          shopCoords.set(r.id, {
            name: r.name,
            lat: r.lat != null ? Number(r.lat) : NaN,
            lng: r.lng != null ? Number(r.lng) : NaN,
          })
        }
      }
    } catch (err) {
      logger.warn(
        { userId, err: err.message, action: 'order_shop_coords' },
        'Failed to resolve shop coordinates; delivery fee will use safe fallback'
      )
    }

    const feeContext = {
      deliveryCoords: { lat: addressLat, lng: addressLng },
      shopCoords,
      couponDiscount: appliedCouponDiscount,
      couponShopId,
      // Tip applies to a single order only (single-shop checkouts).
      tipAmount: orderTipAmount,
      tipShopId: groupedByShop.size === 1 ? Array.from(groupedByShop.keys())[0] : null,
    }

    // 5. Transaction: split + create orders + decrement stock atomically
    const client = await getClient()
    let createdOrders = []
    try {
      await client.query('BEGIN')

      const groups = this.orderSplitter.splitCart(cartItems)
      createdOrders = await this.orderSplitter.createOrders({
        client,
        userId,
        groups,
        deliveryAddress,
        payment: { method: normalizedPaymentMethod, status: initialPaymentStatus },
        feeContext,
        checkoutMeta: {
          couponCode: appliedCouponCode,
          deliveryNotes: deliveryNotes || null,
          deliveryInstructions: resolvedInstructions,
          // Delivery slot
          deliveryMode: resolvedDeliveryMode,
          scheduledDeliveryAt: resolvedDeliveryMode === 'SCHEDULED' ? (scheduledDeliveryAt || scheduledSlotStart) : null,
          scheduledSlotStart: resolvedDeliveryMode === 'SCHEDULED' ? scheduledSlotStart : null,
          scheduledSlotEnd: resolvedDeliveryMode === 'SCHEDULED' ? scheduledSlotEnd : null,
          scheduledSlotLabel: resolvedDeliveryMode === 'SCHEDULED' ? (scheduledSlotLabel || null) : null,
        },
      })

      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      logger.error(
        {
          err: err.message,
          userId,
          code: err.code,
          failures: err.failures || null,
        },
        'Order placement failed; transaction rolled back'
      )
      if (err.code === 'CHECKOUT_PARTIAL_FAIL') {
        return {
          success: false,
          message: 'Some items in your cart cannot be ordered right now',
          code: 'CHECKOUT_PARTIAL_FAIL',
          failures: err.failures || [],
        }
      }
      return {
        success: false,
        message: err.message || 'Failed to place order',
        code: err.code || 'ORDER_FAILED',
      }
    } finally {
      client.release()
    }

    // 6. Post-commit cleanup + side effects (best-effort; do not fail the
    //    customer if any of these throw).
    try {
      // For ONLINE and WALLET payments, do NOT clear cart yet — cart is only
      // cleared after successful payment verification / wallet deduction.
      // This prevents the "cart disappeared but payment failed" bug.
      if (normalizedPaymentMethod !== 'ONLINE' && normalizedPaymentMethod !== 'WALLET') {
        await this.cartService.clearCart(userId)
      }
      if (appliedCouponCode && createdOrders.length === 1) {
        await this.couponsService.recordUsage(
          appliedCouponCode,
          userId,
          createdOrders[0].id
        )
      }
    } catch (err) {
      logger.warn(
        { err: err.message, userId, orderIds: createdOrders.map((o) => o.id) },
        'Post-order cleanup partial failure'
      )
    }

    // Stock-transition side effects (Req 11.1–11.4, 11.6, 11.9). Fired AFTER
    // COMMIT so a rolled-back checkout never emits user-facing events.
    // Already wrapped in a try/catch inside the splitter, but we add an
    // outer guard here to defend against an exception escaping the helper.
    try {
      const transitions = createdOrders.stockTransitions || []
      await this.orderSplitter.firePostCommitSideEffects(transitions)
    } catch (err) {
      logger.warn(
        {
          err: err.message,
          userId,
          orderIds: createdOrders.map((o) => o.id),
          action: 'order_stock_transitions_fan_out',
        },
        'Order-driven stock transition fan-out failed'
      )
    }

    // Per-order delivery assignment + notifications (Req 5.8)
    for (const order of createdOrders) {
      logger.info(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          shopId: order.shopId,
          userId,
          total: order.totalAmount,
          paymentMethod: normalizedPaymentMethod,
          status: order.status,
          action: 'order_placed',
        },
        'Per-shop order placed successfully'
      )

      // For ONLINE and WALLET payments, do NOT send "Order placed" notification yet.
      // - ONLINE: notification sent after Razorpay payment verification
      // - WALLET: notification sent after wallet deduction succeeds
      // This prevents false "Order placed" notifications when payment fails.
      if (normalizedPaymentMethod !== 'ONLINE' && normalizedPaymentMethod !== 'WALLET') {
        await this._sendCustomerOrderNotification(
          userId,
          buildCustomerOrderEventNotification({
            orderId: order.id,
            orderNumber: order.orderNumber,
            timelineType: 'ORDER_PLACED',
            status: order.status,
          })
        )
      }

      if (order.status === ORDER_STATUS.CONFIRMED) {
        await this._queueAutoAssign(order.id, 'ORDER_PLACED_COD')
      }
    }

    // Apply delivery instructions only. Tip + all fees (handling/platform/
    // delivery/coupon discount/savings) are computed authoritatively by the
    // fee engine at order-creation time and persisted in the transaction, so
    // we must NOT overwrite them here from the client request body.
    if (createdOrders.length === 1 && resolvedInstructions) {
      try {
        await this.repo.updateExtras(createdOrders[0].id, {
          deliveryInstructions: resolvedInstructions,
        })
      } catch (err) {
        logger.warn(
          { err: err.message, orderId: createdOrders[0].id },
          'Failed to update order extras (non-critical)'
        )
      }
    }

    // Backwards-compatible response shape: callers that expect a single
    // `order` field still get the first order; new clients should read the
    // `orders` array.
    return {
      success: true,
      orders: createdOrders,
      order: createdOrders[0],
    }
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
      orders: await this._attachItemThumbnails(orders),
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
        shopId: item.shopId || order.shopId || null,
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

    const [enriched] = await this._attachItemThumbnails([order])

    return {
      ...enriched,
      timeline: this._buildCustomerTimeline(order, statusHistory || []),
      tracking: this._buildTrackingData(order, riderLocation),
    }
  }

  /**
   * Enrich denormalized order items with the current product thumbnail.
   *
   * Order items are point-in-time snapshots without an image, so customer
   * order screens look thin. We batch-resolve thumbnails for every item across
   * all supplied orders in a single query (no N+1) and attach `thumbnailUrl`.
   * Failures are swallowed — a missing image must never break the orders list.
   *
   * @param {Array<object>} orders
   * @returns {Promise<Array<object>>}
   */
  async _attachItemThumbnails(orders) {
    if (!Array.isArray(orders) || orders.length === 0) {
      return orders || []
    }

    try {
      const productIds = []
      for (const order of orders) {
        for (const item of order.items || []) {
          if (item && item.productId) {
            productIds.push(item.productId)
          }
        }
      }

      if (productIds.length === 0) {
        return orders
      }

      const thumbnailMap = await this.repo.findThumbnailsByProductIds(productIds)

      return orders.map((order) => ({
        ...order,
        items: (order.items || []).map((item) => {
          const raw = thumbnailMap.get(item.productId) || null
          return {
            ...item,
            thumbnailUrl: raw
              ? normalizeCloudinaryDeliveryUrl(raw, 'thumb')
              : null,
          }
        }),
      }))
    } catch (err) {
      logger.warn(
        { err: err.message, action: 'attach_item_thumbnails' },
        'Failed to enrich order items with thumbnails'
      )
      return orders
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
