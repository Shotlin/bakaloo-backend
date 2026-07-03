import { CartRepository } from './cart.repository.js'
import { CartService } from './cart.service.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { TotalsEngine } from './totals-engine.service.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { CartMilestonesService } from '../cart-milestones/cart-milestones.service.js'
import { haversineKm } from '../../utils/distance.js'
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

/**
 * Bill summary service — computes the complete cart bill breakdown for
 * GET /api/v1/cart/summary.
 *
 * Source of truth: the canonical {@link TotalsEngine} + the `fee_settings`
 * config. Delivery fee is dynamic (distance-based) and computed per shop so
 * the summary agrees with what order creation actually charges (orders split
 * per shop). Distance is the haversine between the customer's selected/default
 * delivery address and each shop.
 *
 * Backward compatibility: the response keeps the original keys
 * (itemTotal, deliveryFee{amount,isFree,freeIn}, handlingFee, lateNightFee,
 * toPay, savings, deliveryEstimate, couponDiscount, tipAmount, itemCount) so
 * the current Flutter build keeps working, AND adds the new canonical fields
 * (totals, fees[], distance, freeDelivery, platformFee, smallCartFee, …) for
 * the redesigned bill UI.
 */
export class BillSummaryService {
  constructor({
    cartService = null,
    cartRepository = null,
    feeSettingsService = null,
    totalsEngine = null,
    paymentSettingsService = null,
    cartMilestonesService = null,
  } = {}) {
    this.cartRepository = cartRepository ?? new CartRepository()
    this.cartService = cartService ?? new CartService(this.cartRepository)
    this.feeSettingsService = feeSettingsService ?? new FeeSettingsService()
    this.totalsEngine =
      totalsEngine ?? new TotalsEngine({ feeSettingsService: this.feeSettingsService })
    this.paymentSettingsService = paymentSettingsService ?? new PaymentSettingsService()
    this.cartMilestonesService = cartMilestonesService ?? new CartMilestonesService()
  }

  /**
   * Compute the bill summary for a user's cart.
   * @param {string} userId
   * @param {string|null} [addressId] - optional selected address; defaults to the user's default address
   */
  async getBillSummary(userId, addressId = null) {
    const cart = await this.cartService.getCart(userId)
    const paymentConfig = await this.paymentSettingsService.getConfig()
    if (!cart.items || cart.items.length === 0) {
      return this._emptyBill(paymentConfig)
    }

    const itemTotalDiscounted = this._round(cart.subtotal)
    const itemTotalOriginal = this._round(cart.totalMrp || cart.subtotal)
    const mrpDiscount = this._round(Math.max(0, itemTotalOriginal - itemTotalDiscounted))
    const tipAmount = this._toNumber(cart.tipAmount)

    // Resolve delivery coordinates + per-shop distances.
    const address = await this._resolveAddress(userId, addressId)
    const shopGroups = cart.shopGroups || []
    const shopIds = shopGroups.map((g) => g.shopId)
    const shopMeta = await this._getShopMeta(shopIds)

    // Compute a per-shop breakdown via the engine and aggregate. Delivery and
    // each fee are charged per shop (matching order splitting); the aggregate
    // is what the customer pays in total.
    const { config } = await this.feeSettingsService.resolveForShop(
      shopGroups.length === 1 ? shopGroups[0].shopId : null
    )

    let deliveryFee = 0
    let deliveryFeeOriginal = 0
    let handlingFee = 0
    let platformFee = 0
    let smallCartFee = 0
    let surgeFee = 0
    let packagingFee = 0
    let anyDeliveryWaived = false
    let primaryDistanceKm = null
    let primaryStoreName = null
    let amountToUnlock = 0

    for (const group of shopGroups) {
      const meta = shopMeta.get(group.shopId) || {}
      const distanceKm =
        address && Number.isFinite(meta.lat) && Number.isFinite(meta.lng)
          ? haversineKm(address.lat, address.lng, meta.lat, meta.lng)
          : null

      const shopConfigResolved = await this.feeSettingsService.resolveForShop(group.shopId)
      const breakdown = this.totalsEngine.computeBreakdown({
        config: shopConfigResolved.config,
        itemsSubtotal: group.subtotal,
        distanceKm,
        storeName: meta.name || group.shopName || null,
      })

      deliveryFee = this._round(deliveryFee + breakdown.deliveryFee)
      deliveryFeeOriginal = this._round(deliveryFeeOriginal + breakdown.deliveryFeeOriginal)
      handlingFee = this._round(handlingFee + breakdown.handlingFee)
      platformFee = this._round(platformFee + breakdown.platformFee)
      smallCartFee = this._round(smallCartFee + breakdown.smallCartFee)
      surgeFee = this._round(surgeFee + breakdown.surgeFee)
      packagingFee = this._round(packagingFee + breakdown.packagingFee)
      if (breakdown.deliveryFeeWaived) anyDeliveryWaived = true
      amountToUnlock = this._round(amountToUnlock + breakdown.freeDelivery.amountToUnlock)

      // Use the primary (first / single) shop for the headline distance label.
      if (primaryDistanceKm === null && breakdown.distance.known) {
        primaryDistanceKm = breakdown.distance.km
        primaryStoreName = meta.name || group.shopName || null
      }
    }

    // Build a single aggregate breakdown for the canonical response.
    const aggregate = this.totalsEngine.computeBreakdown({
      config,
      itemsSubtotal: itemTotalDiscounted,
      itemDiscount: mrpDiscount,
      distanceKm: primaryDistanceKm,
      tipAmount,
      storeName: primaryStoreName,
    })

    // Override the aggregate's per-fee numbers with the summed per-shop values
    // so multi-shop carts reflect the real charge.
    aggregate.deliveryFee = deliveryFee
    aggregate.deliveryFeeOriginal = deliveryFeeOriginal
    aggregate.deliveryFeeWaived = anyDeliveryWaived && deliveryFee === 0
    aggregate.handlingFee = handlingFee
    aggregate.platformFee = platformFee
    aggregate.smallCartFee = smallCartFee
    aggregate.surgeFee = surgeFee
    aggregate.packagingFee = packagingFee
    aggregate.freeDelivery.amountToUnlock = aggregate.deliveryFeeWaived ? 0 : amountToUnlock
    aggregate.freeDelivery.unlocked = aggregate.deliveryFeeWaived

    const feesTotal = this._round(
      deliveryFee + handlingFee + platformFee + smallCartFee + surgeFee + packagingFee
    )
    const toPayFinal = this._round(itemTotalDiscounted + feesTotal + tipAmount)
    const toPayOriginal = this._round(
      itemTotalOriginal + deliveryFeeOriginal + handlingFee + platformFee + smallCartFee + surgeFee + packagingFee + tipAmount
    )
    aggregate.totalPayable = toPayFinal
    aggregate.itemsSubtotal = itemTotalDiscounted
    aggregate.itemDiscount = mrpDiscount

    // Rebuild the canonical fees[] array from aggregated values.
    aggregate.fees = this._buildFeesArray({
      config,
      deliveryFee,
      deliveryFeeOriginal,
      deliveryWaived: aggregate.deliveryFeeWaived,
      handlingFee,
      platformFee,
      smallCartFee,
      surgeFee,
      packagingFee,
      distanceKm: primaryDistanceKm,
      storeName: primaryStoreName,
      amountToUnlock,
    })

    const deliveryEstimateMinutes = this._toNumber(config.delivery_eta_minutes) || 30
    const freeThreshold = aggregate.freeDelivery.threshold

    // Cart milestone progress (Phase 3) — powers the mobile Smart Bottom
    // Bar's "Add ₹X more to unlock…" state, plus a full merged ladder (free
    // delivery + every cart-milestone tier this user is eligible for, in
    // one ascending sequence) so the bar can render a single segmented
    // progress track instead of resetting to 0% every time a tier is
    // crossed — each tier fills its own segment as the cart approaches it,
    // and every earlier segment stays fully filled once passed.
    // Best-effort: a milestone lookup failure must never break the cart summary itself.
    let cartMilestone = { unlocked: null, next: null, ladder: [] }
    try {
      const [progress, eligibleTiers] = await Promise.all([
        this.cartMilestonesService.getProgress(userId, itemTotalDiscounted),
        this.cartMilestonesService.getEligibleTiers(userId),
      ])
      const ladder = this._buildRewardLadder({
        freeDeliveryEnabled: aggregate.freeDelivery.enabled,
        freeDeliveryThreshold: freeThreshold,
        tiers: eligibleTiers,
        cartTotal: itemTotalDiscounted,
      })
      cartMilestone = { ...progress, ladder }
    } catch (err) {
      logger.warn({ userId, err: err.message, action: 'bill_summary_milestone' }, 'Cart milestone progress failed')
    }

    // ── Legacy-compatible shape + new canonical fields ──────────
    return {
      // legacy keys (current Flutter)
      itemTotal: {
        original: itemTotalOriginal,
        discounted: itemTotalDiscounted,
      },
      deliveryFee: {
        amount: deliveryFee,
        isFree: aggregate.deliveryFeeWaived,
        freeIn: aggregate.deliveryFeeWaived ? 0 : amountToUnlock,
        originalAmount: deliveryFeeOriginal,
        waiverReason: aggregate.deliveryFeeWaiverReason,
      },
      handlingFee: {
        amount: handlingFee,
        isFree: handlingFee <= 0,
        savedAmount: 0,
      },
      lateNightFee: {
        amount: 0,
        isFree: true,
        savedAmount: 0,
        isLateNight: false,
      },
      couponDiscount: 0, // applied by coupon system at checkout
      tipAmount,
      toPay: {
        original: toPayOriginal,
        final: toPayFinal,
      },
      savings: {
        total: aggregate.totalSavings,
        breakdown: mrpDiscount > 0
          ? [{ type: 'mrp_discount', label: 'Discount on MRP', amount: mrpDiscount }]
          : [],
      },
      deliveryEstimate: {
        minutes: deliveryEstimateMinutes,
        label: `Delivering in ${deliveryEstimateMinutes} mins`,
      },
      itemCount: cart.count,

      // new canonical fields (redesigned bill UI)
      totals: aggregate,
      fees: aggregate.fees,
      distance: aggregate.distance,
      freeDelivery: {
        enabled: aggregate.freeDelivery.enabled,
        threshold: freeThreshold,
        unlocked: aggregate.deliveryFeeWaived,
        amountToUnlock: aggregate.deliveryFeeWaived ? 0 : amountToUnlock,
      },
      platformFee: { amount: platformFee, isFree: platformFee <= 0 },
      smallCartFee: { amount: smallCartFee, isFree: smallCartFee <= 0 },
      totalPayable: toPayFinal,
      paymentMethods: this._buildPaymentMethods(paymentConfig, toPayFinal),
      cartMilestone,
    }
  }

  /** Build the cod/razorpay/wallet availability block from the resolved config + bill total. */
  _buildPaymentMethods(config, totalPayable) {
    const { codEnabled, codMinOrderAmount, codMaxOrderAmount, razorpayEnabled, walletEnabled } = config

    let codReason = null
    let codAvailable = codEnabled
    if (!codEnabled) {
      codReason = 'Cash on Delivery is currently unavailable.'
      codAvailable = false
    } else if (totalPayable < codMinOrderAmount) {
      const shortfall = this._round(codMinOrderAmount - totalPayable)
      codReason = `Add ₹${shortfall} more to use Cash on Delivery — available above ₹${codMinOrderAmount}.`
      codAvailable = false
    } else if (codMaxOrderAmount != null && totalPayable > codMaxOrderAmount) {
      codReason = `Cash on Delivery isn't available above ₹${codMaxOrderAmount} — please pay online.`
      codAvailable = false
    }

    return {
      cod: {
        enabled: codEnabled,
        available: codAvailable,
        minAmount: codMinOrderAmount,
        maxAmount: codMaxOrderAmount,
        reason: codReason,
      },
      razorpay: { enabled: razorpayEnabled },
      wallet: { enabled: walletEnabled },
    }
  }

  /** Build the canonical fees[] array from aggregated fee values. */
  _buildFeesArray({
    config,
    deliveryFee,
    deliveryFeeOriginal,
    deliveryWaived,
    handlingFee,
    platformFee,
    smallCartFee,
    surgeFee,
    packagingFee,
    distanceKm,
    storeName,
    amountToUnlock,
  }) {
    const fees = []
    if (config.delivery_fee_enabled) {
      const desc = deliveryWaived
        ? 'Free delivery unlocked'
        : distanceKm !== null && distanceKm !== undefined
          ? `Calculated for ${Number(distanceKm).toFixed(1)} km${storeName ? ` from ${storeName}` : ''}`
          : 'Standard delivery charge'
      fees.push({
        code: 'DELIVERY_FEE',
        label: config.delivery_fee_label || 'Delivery fee',
        amount: deliveryFee,
        originalAmount: deliveryFeeOriginal,
        waived: deliveryWaived,
        description: desc,
        metadata: { distanceKm: distanceKm ?? null, storeName: storeName || null },
      })
    }
    if (handlingFee > 0) {
      fees.push({
        code: 'HANDLING_FEE',
        label: config.handling_fee_label || 'Handling fee',
        amount: handlingFee,
        originalAmount: handlingFee,
        waived: false,
        description: config.handling_fee_description || 'Covers packing and order handling.',
        metadata: {},
      })
    }
    if (platformFee > 0) {
      fees.push({
        code: 'PLATFORM_FEE',
        label: config.platform_fee_label || 'Platform fee',
        amount: platformFee,
        originalAmount: platformFee,
        waived: false,
        description: config.platform_fee_description || 'Supports platform operations and support.',
        metadata: {},
      })
    }
    if (smallCartFee > 0) {
      fees.push({
        code: 'SMALL_CART_FEE',
        label: config.small_cart_fee_label || 'Small cart fee',
        amount: smallCartFee,
        originalAmount: smallCartFee,
        waived: false,
        description: config.small_cart_fee_description || 'Applied to small orders.',
        metadata: {},
      })
    }
    if (surgeFee > 0) {
      fees.push({
        code: 'SURGE_FEE',
        label: config.surge_fee_label || 'Surge fee',
        amount: surgeFee,
        originalAmount: surgeFee,
        waived: false,
        description: config.surge_fee_description || 'Temporary surcharge during high demand.',
        metadata: {},
      })
    }
    if (packagingFee > 0) {
      fees.push({
        code: 'PACKAGING_FEE',
        label: config.packaging_fee_label || 'Packaging fee',
        amount: packagingFee,
        originalAmount: packagingFee,
        waived: false,
        description: config.packaging_fee_description || 'Covers packaging materials.',
        metadata: {},
      })
    }
    return fees
  }

  /**
   * Merge the free-delivery threshold and every eligible cart-milestone
   * tier into a single ascending sequence of "checkpoints", each with a
   * self-contained 0–1 `segmentProgress` — how far the cart has filled
   * *that* checkpoint's own span (from the previous checkpoint's amount up
   * to this one), not the overall cart-vs-final-tier fraction. This is
   * what lets the mobile Smart Bottom Bar render one continuous segmented
   * progress track (each tier its own segment, with a gap marker at every
   * boundary) instead of a single bar that resets to 0% each time a tier
   * is crossed.
   */
  _buildRewardLadder({ freeDeliveryEnabled, freeDeliveryThreshold, tiers, cartTotal }) {
    const checkpoints = []
    if (freeDeliveryEnabled && freeDeliveryThreshold != null && freeDeliveryThreshold > 0) {
      checkpoints.push({
        id: 'free-delivery',
        label: 'Free delivery',
        minAmount: this._round(freeDeliveryThreshold),
      })
    }
    for (const tier of tiers) {
      checkpoints.push({
        id: tier.id,
        label: tier.name,
        minAmount: this._round(tier.minCartAmount),
      })
    }
    checkpoints.sort((a, b) => a.minAmount - b.minAmount)

    let previousAmount = 0
    return checkpoints.map((checkpoint) => {
      const span = checkpoint.minAmount - previousAmount
      const achieved = cartTotal >= checkpoint.minAmount
      const segmentProgress = achieved
        ? 1
        : span > 0
          ? Math.max(0, Math.min(1, (cartTotal - previousAmount) / span))
          : 0
      previousAmount = checkpoint.minAmount
      return { ...checkpoint, achieved, segmentProgress: this._round(segmentProgress) }
    })
  }

  /** Resolve the delivery address (selected or default) with coordinates. */
  async _resolveAddress(userId, addressId) {
    try {
      if (addressId) {
        const { rows } = await query(
          `SELECT lat, lng FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
          [addressId, userId]
        )
        if (rows[0] && rows[0].lat != null && rows[0].lng != null) {
          return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) }
        }
      }
      const { rows } = await query(
        `SELECT lat, lng FROM addresses
          WHERE user_id = $1 AND lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL
          ORDER BY is_default DESC, created_at DESC
          LIMIT 1`,
        [userId]
      )
      if (rows[0]) return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) }
    } catch (err) {
      logger.warn({ userId, err: err.message, action: 'bill_summary_address' }, 'Address resolve failed')
    }
    return null
  }

  /** Fetch lat/lng/name for a set of shops. */
  async _getShopMeta(shopIds) {
    const map = new Map()
    if (!shopIds || shopIds.length === 0) return map
    try {
      const { rows } = await query(
        `SELECT id, name, lat, lng FROM shops WHERE id = ANY($1)`,
        [shopIds]
      )
      for (const r of rows) {
        map.set(r.id, {
          name: r.name,
          lat: r.lat != null ? Number(r.lat) : NaN,
          lng: r.lng != null ? Number(r.lng) : NaN,
        })
      }
    } catch (err) {
      logger.warn({ err: err.message, action: 'bill_summary_shop_meta' }, 'Shop meta fetch failed')
    }
    return map
  }

  _emptyBill(paymentConfig = null) {
    return {
      itemTotal: { original: 0, discounted: 0 },
      deliveryFee: { amount: 0, isFree: false, freeIn: 0, originalAmount: 0, waiverReason: null },
      handlingFee: { amount: 0, isFree: true, savedAmount: 0 },
      lateNightFee: { amount: 0, isFree: true, savedAmount: 0, isLateNight: false },
      couponDiscount: 0,
      tipAmount: 0,
      toPay: { original: 0, final: 0 },
      savings: { total: 0, breakdown: [] },
      deliveryEstimate: { minutes: 30, label: 'Delivering in 30 mins' },
      itemCount: 0,
      totals: null,
      fees: [],
      distance: { km: null, label: '', known: false },
      freeDelivery: { enabled: true, threshold: null, unlocked: false, amountToUnlock: 0 },
      platformFee: { amount: 0, isFree: true },
      smallCartFee: { amount: 0, isFree: true },
      totalPayable: 0,
      paymentMethods: paymentConfig ? this._buildPaymentMethods(paymentConfig, 0) : null,
      cartMilestone: { unlocked: null, next: null, ladder: [] },
    }
  }

  _toNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  _round(value) {
    return Math.round((this._toNumber(value) + Number.EPSILON) * 100) / 100
  }
}
