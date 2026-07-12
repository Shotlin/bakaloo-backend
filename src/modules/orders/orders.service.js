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
import { AbandonedCartsRepository } from '../abandoned-carts/abandoned-carts.repository.js'
import { AddressesRepository } from '../addresses/addresses.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'
import { CouponsService } from '../coupons/coupons.service.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'
import { ShopProductsService } from '../shop-products/shop-products.service.js'
import { OrderSplitterService } from './order-splitter.service.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { TotalsEngine } from '../cart/totals-engine.service.js'
import { BillSummaryService } from '../cart/bill-summary.service.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { FirstTimeOffersService } from '../first-time-offers/first-time-offers.service.js'
import { CashbackService } from '../cashback/cashback.service.js'
import { CartMilestonesService } from '../cart-milestones/cart-milestones.service.js'
import { PaymentOffersService } from '../payment-offers/payment-offers.service.js'
import { getStoreStatusService } from '../store-status/store-status.routes.js'
import { getDeliveryCalendarService } from '../delivery-calendar/delivery-calendar.routes.js'

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
    this.abandonedCartsRepo =
      options.abandonedCartsRepository || new AbandonedCartsRepository()
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
    // Payment-method gating — same total-bill calculation the cart summary
    // shows the customer, so COD/Razorpay/Wallet enforcement at order
    // creation always agrees with what was displayed at checkout.
    this.paymentSettingsService =
      options.paymentSettingsService || new PaymentSettingsService()
    this.billSummaryService =
      options.billSummaryService ||
      new BillSummaryService({
        cartService: this.cartService,
        cartRepository: this.cartRepo,
        feeSettingsService: this.feeSettingsService,
        totalsEngine: this.totalsEngine,
        paymentSettingsService: this.paymentSettingsService,
      })
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
    this.firstTimeOffersService =
      options.firstTimeOffersService || new FirstTimeOffersService()
    this.cashbackService = options.cashbackService || new CashbackService()
    this.cartMilestonesService =
      options.cartMilestonesService || new CartMilestonesService()
    this.paymentOffersService =
      options.paymentOffersService || new PaymentOffersService()
    // Resolved lazily via the shared singleton getters (not `new`d here) so
    // every module reads/writes the same store-status/calendar state —
    // mirrors how getStoreStatusService()/getDeliveryCalendarService() are
    // consumed elsewhere (banners, the calendar's own public route).
    this.storeStatusService =
      options.storeStatusService || getStoreStatusService()
    this.deliveryCalendarService =
      options.deliveryCalendarService || getDeliveryCalendarService()
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
      // Quick Delivery — explicit opt-in only, never a silent default fee.
      quickDeliverySelected,
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
      // Max ahead = however far the admin has actually generated the
      // delivery calendar (was a hardcoded 7 days; the calendar now
      // genuinely extends forward, so this reflects that instead of
      // silently re-imposing the old cap).
      const maxAhead = await this._resolveMaxScheduledAhead(now)
      if (slotStart > maxAhead) {
        return {
          success: false,
          message: 'Scheduled delivery time is beyond the currently available calendar',
          code: 'SLOT_TOO_FAR_AHEAD',
        }
      }
    }

    // Closed-store gate: an ASAP order must not be accepted while the store
    // is closed (manual override or outside weekly hours) — the mobile app
    // steers customers to SCHEDULED before submit, but the API must not
    // trust the client alone. Scheduled orders are unaffected — a customer
    // can always book a future slot regardless of whether the store happens
    // to be closed at the moment they're checking out.
    if (resolvedDeliveryMode === 'ASAP') {
      const storeClosedFailure = await this._checkStoreOpenForAsap()
      if (storeClosedFailure) return storeClosedFailure
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

    // 2b. Payment-method gate — enforce the admin's COD/Razorpay/Wallet
    // toggles and the COD min/max amount server-side. Uses the same bill
    // calculation the cart summary shows the customer so the total this
    // gate checks against always matches what was displayed at checkout.
    const normalizedPaymentMethod = `${paymentMethod || 'COD'}`.toUpperCase()
    const paymentGateError = await this._checkPaymentMethodAllowed(
      userId,
      addressId,
      normalizedPaymentMethod
    )
    if (paymentGateError) {
      return paymentGateError
    }

    // 3. Apply coupon — only meaningful when the cart is single-shop. For
    //    multi-shop carts coupons are deferred (see method docstring).
    let appliedCouponCode = null
    let appliedCouponDiscount = 0
    let couponShopId = null
    let freeDeliveryOverride = false
    let freeDeliveryShopId = null
    let appliedCouponCashback = null // { amount, creditTrigger } for CASHBACK-type coupons
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
      if (couponResult.freeDelivery) {
        freeDeliveryOverride = true
        freeDeliveryShopId = couponShopId
      }
      if (couponResult.cashbackAmount) {
        appliedCouponCashback = {
          amount: couponResult.cashbackAmount,
          creditTrigger: couponResult.cashbackCreditTrigger,
          couponId: couponResult.couponId,
        }
      }
    }

    // 3b. First-time offer — auto-applies for eligible first-time customers
    // on single-shop carts. Backend validation is the final source of truth
    // here too: resolveForCheckout() re-checks "no prior order" itself, it
    // never trusts anything the client claims about first-order status.
    //
    // Discount-type rewards (FLAT_DISCOUNT/PERCENTAGE_DISCOUNT) yield to an
    // already-applied coupon — they'd otherwise stack two separate
    // order-level discounts through different mechanisms, which is hard to
    // reason about and not something the product spec asked for.
    // FREE_DELIVERY/WALLET_CASHBACK/COUPON_UNLOCK don't touch the coupon's
    // discount bill line at all, so those always apply when eligible.
    let firstTimeOffer = null
    let firstTimeReward = null
    if (groupedByShop.size === 1) {
      const onlinePayment = normalizedPaymentMethod === 'ONLINE'
      const resolvedOffer = await this.firstTimeOffersService.resolveForCheckout(userId, subtotal, {
        onlinePayment,
      })
      if (resolvedOffer?.autoApply) {
        const reward = this.firstTimeOffersService.computeReward(resolvedOffer, subtotal)
        if (reward.discount && appliedCouponCode) {
          // Coupon already occupies the discount slot — skip the stack.
        } else {
          firstTimeOffer = resolvedOffer
          firstTimeReward = reward
          if (reward.discount) {
            appliedCouponDiscount += reward.discount
            couponShopId = couponShopId || Array.from(groupedByShop.keys())[0]
          }
          if (reward.freeDelivery) {
            freeDeliveryOverride = true
            freeDeliveryShopId = Array.from(groupedByShop.keys())[0]
          }
        }
      }
    }

    // 3c. Cart milestone — the highest cart-value tier this user is
    // eligible for and has already reached with this cart (applies to
    // every order, not just a customer's first). `stackableWithCoupon`
    // is a hard admin toggle: false means the milestone is skipped
    // outright whenever a coupon code was applied to this order, of any
    // reward type. When it does apply, a FLAT_DISCOUNT reward still
    // yields to a coupon/first-time-offer discount already occupying the
    // bill's single discount slot, same rule as first-time offers above.
    let cartMilestone = null
    let cartMilestoneReward = null
    if (groupedByShop.size === 1) {
      const milestone = await this.cartMilestonesService.resolveForCheckout(userId, subtotal)
      if (milestone && !(appliedCouponCode && !milestone.stackableWithCoupon)) {
        const reward = this.cartMilestonesService.computeReward(milestone, subtotal)
        if (reward.discount && (appliedCouponCode || firstTimeReward?.discount)) {
          // Discount slot already taken by a coupon or first-time offer.
        } else {
          cartMilestone = milestone
          cartMilestoneReward = reward
          if (reward.discount) {
            appliedCouponDiscount += reward.discount
            couponShopId = couponShopId || Array.from(groupedByShop.keys())[0]
          }
        }
      }
    }

    // 3d. Payment offer — the best-fit admin-configured cashback offer this
    // cart qualifies for (e.g. "min order ₹50 → ₹50 cashback"). Payment
    // offers only ever produce cashback (never a discount), so unlike the
    // coupon/first-time-offer/milestone block above there's no discount-slot
    // contention to resolve here — this always stacks additively, exactly
    // like the CASHBACK-type coupon/milestone rewards already do.
    let paymentOfferMatch = null
    if (groupedByShop.size === 1) {
      paymentOfferMatch = await this.paymentOffersService.resolveForCheckout(userId, subtotal)
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
      freeDeliveryOverride,
      freeDeliveryShopId,
      // Tip applies to a single order only (single-shop checkouts).
      tipAmount: orderTipAmount,
      tipShopId: groupedByShop.size === 1 ? Array.from(groupedByShop.keys())[0] : null,
      // Quick Delivery surcharge — only meaningful for ASAP orders, same
      // single-shop assignment convention as tip.
      quickDeliverySelected: resolvedDeliveryMode === 'ASAP' && !!quickDeliverySelected,
      quickDeliveryShopId: groupedByShop.size === 1 ? Array.from(groupedByShop.keys())[0] : null,
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
      // Abandoned-cart conversion: fires the moment order rows exist,
      // regardless of payment method. Cart-clearing itself is deferred for
      // ONLINE/WALLET (see below) and for those methods happens later in
      // payments.service.js / wallet.service.js after payment confirms —
      // "order created" here is the one method-agnostic point common to
      // every payment path, so it's hooked here rather than at cart-clear.
      if (createdOrders.length > 0) {
        await this.abandonedCartsRepo
          .markConvertedByUserId(userId, createdOrders[0].id)
          .catch((err) =>
            logger.warn({ userId, err: err.message }, 'Abandoned-cart conversion flip failed')
          )
      }

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
          createdOrders[0].id,
          { shopId: couponShopId, discountAmount: appliedCouponDiscount }
        )
      }
      // CASHBACK-type coupon follow-through: create the PENDING cashback
      // row, same as a first-time-offer's WALLET_CASHBACK reward.
      if (appliedCouponCashback && createdOrders.length === 1) {
        await this.cashbackService.createPending({
          orderId: createdOrders[0].id,
          userId,
          sourceType: 'COUPON',
          sourceId: appliedCouponCashback.couponId,
          amount: appliedCouponCashback.amount,
          creditTrigger: appliedCouponCashback.creditTrigger,
        })
      }
      // First-time offer follow-through: create the PENDING cashback row
      // (credited later by the matching order-lifecycle hook) or unlock the
      // reward coupon for this user. Nothing here touches the bill — that
      // was already applied via appliedCouponDiscount/freeDeliveryOverride
      // before the order was created.
      if (firstTimeOffer && firstTimeReward && createdOrders.length === 1) {
        if (firstTimeReward.cashbackAmount) {
          await this.cashbackService.createPending({
            orderId: createdOrders[0].id,
            userId,
            sourceType: 'FIRST_TIME_OFFER',
            sourceId: firstTimeOffer.id,
            amount: firstTimeReward.cashbackAmount,
            creditTrigger: firstTimeOffer.cashbackCreditTrigger,
          })
        }
        if (firstTimeReward.unlockCouponId) {
          await this.couponsRepo.addTargetUser(firstTimeReward.unlockCouponId, userId)
        }
      }
      // Cart milestone follow-through — same pattern as first-time offers.
      if (cartMilestone && cartMilestoneReward && createdOrders.length === 1) {
        if (cartMilestoneReward.cashbackAmount) {
          await this.cashbackService.createPending({
            orderId: createdOrders[0].id,
            userId,
            sourceType: 'CART_MILESTONE',
            sourceId: cartMilestone.id,
            amount: cartMilestoneReward.cashbackAmount,
            creditTrigger: cartMilestone.cashbackCreditTrigger,
          })
        }
        if (cartMilestoneReward.unlockCouponId) {
          await this.couponsRepo.addTargetUser(cartMilestoneReward.unlockCouponId, userId)
        }
        await this.cartMilestonesService.recordUsage(cartMilestone.id, userId, createdOrders[0].id)
      }
      // Payment offer follow-through — was previously entirely missing;
      // getPublicOffers() only ever computed a lock/unlock display flag,
      // nothing here ever credited the cashback a customer actually earned.
      if (paymentOfferMatch && createdOrders.length === 1) {
        await this.cashbackService.createPending({
          orderId: createdOrders[0].id,
          userId,
          sourceType: 'PAYMENT_OFFER',
          sourceId: paymentOfferMatch.offerId,
          amount: paymentOfferMatch.cashbackAmount,
          creditTrigger: paymentOfferMatch.creditTrigger,
        })
        await this.paymentOffersService.recordUsage(paymentOfferMatch.offerId, userId, createdOrders[0].id)
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
        // COD orders reach CONFIRMED right here (no separate payment webhook
        // exists for COD) — credit any cashback whose trigger is
        // ORDER_CONFIRMED now instead of waiting for a hook that will never fire.
        this.cashbackService.evaluateAndCredit(order.id, 'ORDER_CONFIRMED').catch((err) => {
          logger.warn({ err: err.message, orderId: order.id }, 'Cashback evaluation failed (COD confirm)')
        })
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
   * The furthest a SCHEDULED slot may start — however far the admin has
   * actually generated the delivery calendar. Falls back to the old
   * hardcoded 7-day cap only if the calendar has genuinely never been
   * generated (defensive; the generation worker runs on every boot).
   */
  async _resolveMaxScheduledAhead(now) {
    const maxGeneratedDate = await this.deliveryCalendarService.getMaxGeneratedDate()
    if (!maxGeneratedDate) {
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    }
    const dateStr =
      maxGeneratedDate instanceof Date
        ? maxGeneratedDate.toISOString().slice(0, 10)
        : maxGeneratedDate
    return new Date(`${dateStr}T23:59:59.999Z`)
  }

  /**
   * Blocks ASAP ordering while the store is closed. Returns a
   * `{ success: false, ... }` payload (matching every other early-return
   * in `placeOrder`) when closed, or `null` when it's fine to proceed.
   */
  async _checkStoreOpenForAsap() {
    const { isOpen } = await this.storeStatusService.isOpen()
    if (isOpen) return null
    return {
      success: false,
      message: 'The store is currently closed. Please choose a scheduled delivery time instead.',
      code: 'STORE_CLOSED_ASAP_UNAVAILABLE',
    }
  }

  /**
   * Enforce the admin's COD/Razorpay/Wallet toggles + COD min/max amount
   * before an order is created. Returns a `{ success: false, ... }` payload
   * (matching every other early-return in `placeOrder`) when the requested
   * method isn't allowed, or `null` when it's fine to proceed.
   */
  async _checkPaymentMethodAllowed(userId, addressId, normalizedPaymentMethod) {
    const config = await this.paymentSettingsService.getConfig()

    if (normalizedPaymentMethod === 'ONLINE') {
      if (!config.razorpayEnabled) {
        return {
          success: false,
          message: 'Online payment is currently unavailable. Please choose another payment method.',
          code: 'RAZORPAY_DISABLED',
        }
      }
      return null
    }

    if (normalizedPaymentMethod === 'WALLET') {
      if (!config.walletEnabled) {
        return {
          success: false,
          message: 'Wallet payment is currently unavailable. Please choose another payment method.',
          code: 'WALLET_DISABLED',
        }
      }
      return null
    }

    // COD (default)
    if (!config.codEnabled) {
      return {
        success: false,
        message: 'Cash on Delivery is currently unavailable. Please choose another payment method.',
        code: 'COD_DISABLED',
      }
    }

    const { totalPayable } = await this.billSummaryService.getBillSummary(userId, addressId)
    if (totalPayable < config.codMinOrderAmount) {
      return {
        success: false,
        message: `Cash on Delivery is available for orders above ₹${config.codMinOrderAmount}.`,
        code: 'COD_BELOW_MIN',
      }
    }
    if (config.codMaxOrderAmount != null && totalPayable > config.codMaxOrderAmount) {
      return {
        success: false,
        message: `Cash on Delivery isn't available for orders above ₹${config.codMaxOrderAmount}. Please pay online.`,
        code: 'COD_ABOVE_MAX',
      }
    }
    return null
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

    // Restore stock in a transaction — goes through the centralized
    // applyStockChange() so this gets a CANCELLATION_RESTORE stock_movements
    // ledger row (previously this used a raw UPDATE with no ledger entry
    // and no cache invalidation, unlike every other stock-mutating path).
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await this.shopProductsRepo.restoreStockForCancelledOrder(client, {
        orderId,
        items: order.items,
        source: 'API',
        actor: { userId, shopRole: null },
      })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, orderId }, 'Stock restore failed during cancellation')
    } finally {
      client.release()
    }

    // Cache invalidation happens after COMMIT per applyStockChange()'s
    // contract — every other stock-mutating path does the same.
    try {
      const shopId = order.shopId || order.shop_id
      if (shopId) await this.shopProductsService.invalidateShopCache(shopId)
    } catch (err) {
      logger.warn({ err: err.message, orderId }, 'Cache invalidation failed after cancel (non-blocking)')
    }

    const updated = await this.repo.updateStatus(orderId, ORDER_STATUS.CANCELLED, {
      cancelledReason: reason || 'Cancelled by customer',
    })

    // Reverse any cashback tied to this order — PENDING rows are simply
    // cancelled, CREDITED rows (e.g. a PAYMENT_SUCCESS-triggered cashback
    // credited before the customer cancelled a still-CONFIRMED order) are
    // clawed back from the wallet. Best-effort, does not block the response.
    this.cashbackService.cancelForOrder(orderId).catch((err) => {
      logger.warn({ err: err.message, orderId }, 'Cashback cancellation failed (customer cancel)')
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
      // Restore stock — goes through the centralized applyStockChange() so
      // this gets a CANCELLATION_RESTORE stock_movements ledger row (was a
      // raw UPDATE with no ledger entry and no cache invalidation).
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await this.shopProductsRepo.restoreStockForCancelledOrder(client, {
          orderId,
          items: order.items,
          source: 'DASHBOARD',
          actor: null,
        })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error({ err, orderId }, 'Stock restore failed during admin cancellation')
      } finally {
        client.release()
      }
      try {
        const shopId = order.shopId || order.shop_id
        if (shopId) await this.shopProductsService.invalidateShopCache(shopId)
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Cache invalidation failed after cancel (non-blocking)')
      }
    }

    const updated = await this.repo.updateStatus(orderId, status, extra)
    logger.info({ orderId, status }, 'Order status updated by admin')

    if (status === ORDER_STATUS.DELIVERED) {
      this.cashbackService.evaluateAndCredit(orderId, 'ORDER_DELIVERED').catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Cashback evaluation failed (admin deliver)')
      })
    }
    if (status === ORDER_STATUS.CANCELLED) {
      this.cashbackService.cancelForOrder(orderId).catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Cashback cancellation failed (admin cancel)')
      })
    }
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

    // Customers can only access their own invoices.
    // `findById` returns the camelCase shape from `_format()` (userId,
    // paymentStatus), not raw snake_case columns — these checks were
    // comparing against always-undefined fields, so every invoice request
    // failed with "Access denied" regardless of actual ownership.
    if (order.userId !== userId) {
      return { success: false, statusCode: 403, message: 'Access denied' }
    }

    if (order.paymentStatus !== 'PAID') {
      return { success: false, statusCode: 400, message: 'Invoice available only for paid orders' }
    }

    // Timeline enriches the CANCELLED/REFUNDED banner with a date + reason;
    // harmless no-op for any other status (generateInvoicePDF only reads it
    // when order.status is terminal-cancelled/refunded).
    const timeline = await this.repo.getStatusHistory(orderId)
    const buffer = await generateInvoicePDF({ ...order, timeline })
    return {
      success: true,
      buffer,
      orderNumber: order.orderNumber,
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
    const [statusHistory, riderLocation, deliveryOtp] = await Promise.all([
      this.repo.getStatusHistory(order.id),
      order.riderId && this.fastify?.getRiderLocation
        ? this.fastify.getRiderLocation(order.riderId).catch(() => null)
        : Promise.resolve(null),
      order.riderId ? this._getActiveDeliveryOtp(order.id) : Promise.resolve(null),
    ])

    const [enriched] = await this._attachItemThumbnails([order])

    return {
      ...enriched,
      deliveryOtp,
      timeline: this._buildCustomerTimeline(order, statusHistory || []),
      tracking: this._buildTrackingData(order, riderLocation),
    }
  }

  /**
   * Delivery OTP for the order's current rider assignment, or null once
   * there's no active (ACCEPTED/IN_TRANSIT) assignment — e.g. before a
   * rider has accepted, or after the order is delivered/cancelled.
   */
  async _getActiveDeliveryOtp(orderId) {
    const { rows } = await query(
      `SELECT delivery_otp FROM delivery_assignments
       WHERE order_id = $1 AND status IN ('ACCEPTED', 'IN_TRANSIT')
       ORDER BY assigned_at DESC LIMIT 1`,
      [orderId]
    )
    return rows[0]?.delivery_otp || null
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
