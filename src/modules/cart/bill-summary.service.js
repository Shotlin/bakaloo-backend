import { CartRepository } from './cart.repository.js'
import { CartService } from './cart.service.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { TotalsEngine } from './totals-engine.service.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { CartMilestonesService } from '../cart-milestones/cart-milestones.service.js'
import { FirstTimeOffersService } from '../first-time-offers/first-time-offers.service.js'
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
    firstTimeOffersService = null,
  } = {}) {
    this.cartRepository = cartRepository ?? new CartRepository()
    this.cartService = cartService ?? new CartService(this.cartRepository)
    this.feeSettingsService = feeSettingsService ?? new FeeSettingsService()
    this.totalsEngine =
      totalsEngine ?? new TotalsEngine({ feeSettingsService: this.feeSettingsService })
    this.paymentSettingsService = paymentSettingsService ?? new PaymentSettingsService()
    this.cartMilestonesService = cartMilestonesService ?? new CartMilestonesService()
    this.firstTimeOffersService = firstTimeOffersService ?? new FirstTimeOffersService()
  }

  /**
   * Compute the bill summary for a user's cart.
   * @param {string} userId
   * @param {string|null} [addressId] - optional selected address; defaults to the user's default address
   */
  async getBillSummary(userId, addressId = null, { quickDeliverySelected = false } = {}) {
    // getCart and getConfig are independent of each other — run together
    // rather than one-after-another. This endpoint is on a latency-sensitive
    // path: the Flutter app refetches it every time the customer navigates
    // from Cart into Checkout, and briefly shows an incomplete local
    // estimate while waiting, so shaving round trips here directly shrinks
    // how often that fallback is visible.
    const [cart, paymentConfig] = await Promise.all([
      this.cartService.getCart(userId),
      this.paymentSettingsService.getConfig(),
    ])
    if (!cart.items || cart.items.length === 0) {
      return this._emptyBill(paymentConfig)
    }

    const itemTotalDiscounted = this._round(cart.subtotal)
    const itemTotalOriginal = this._round(cart.totalMrp || cart.subtotal)
    const mrpDiscount = this._round(Math.max(0, itemTotalOriginal - itemTotalDiscounted))
    const tipAmount = this._toNumber(cart.tipAmount)

    const shopGroups = cart.shopGroups || []
    const shopIds = shopGroups.map((g) => g.shopId)

    // BUG FIX: tip and Quick Delivery are both assigned to exactly one shop
    // at actual order placement — `feeContext.tipShopId`/`quickDeliveryShopId`
    // in orders.service.js#placeOrder are only ever set when
    // `groupedByShop.size === 1`, and OrderSplitterService#computeShopFees
    // charges tip/the surcharge to NO shop at all otherwise (its `=== shopId`
    // match is against `null`, which never matches). So a multi-shop cart's
    // tip (or Quick Delivery surcharge) was previously included in this
    // preview's totalPayable/toPay.final unconditionally, promising a total
    // that checkout would silently under-charge (tip/surcharge dropped) —
    // the "shown one total, charged another" divergence. Chargeable* mirrors
    // that same single-shop-only restriction so the preview only ever
    // promises what checkout will actually collect.
    const isSingleShopCart = shopGroups.length === 1
    const chargeableTipAmount = isSingleShopCart ? tipAmount : 0
    const chargeableQuickDeliverySelected = isSingleShopCart && quickDeliverySelected

    // Delivery coordinates, shop lat/lng, and the aggregate fee config are
    // all independent lookups (none depends on another's result) — run them
    // together. For a single-shop cart (the common case) this resolved
    // config IS the shop's own config, reused below instead of querying the
    // identical row a second time inside the per-shop loop.
    const [address, shopMeta, resolvedShopConfig] = await Promise.all([
      this._resolveAddress(userId, addressId),
      this._getShopMeta(shopIds),
      this.feeSettingsService.resolveForShop(
        shopGroups.length === 1 ? shopGroups[0].shopId : null
      ),
    ])
    const { config } = resolvedShopConfig

    // First-time offer — auto-applies for eligible first-time customers on
    // single-shop carts, mirroring OrdersService.placeOrder()'s rule
    // (single discount slot, single-shop only). Resolved here — not just at
    // order placement — so the customer actually SEES the promised discount
    // while shopping, matching the "auto-apply, no claim step" admin setting.
    // Payment method isn't known yet at cart-view time, so `onlinePayment`
    // is left undefined (best-case preview); order placement re-validates
    // the offer against the real payment method regardless.
    let firstTimeOfferDiscount = 0
    let firstTimeOfferFreeDelivery = false
    let firstTimeOfferMeta = null
    let firstTimeOfferTeaser = null
    if (shopGroups.length === 1) {
      try {
        const resolvedOffer = await this.firstTimeOffersService.resolveForCheckout(
          userId,
          itemTotalDiscounted,
          { cartItems: shopGroups[0].items }
        )
        if (resolvedOffer?.autoApply) {
          const reward = this.firstTimeOffersService.computeReward(resolvedOffer, itemTotalDiscounted)
          if (reward.discount || reward.freeDelivery) {
            firstTimeOfferDiscount = this._round(reward.discount || 0)
            firstTimeOfferFreeDelivery = !!reward.freeDelivery
            firstTimeOfferMeta = {
              id: resolvedOffer.id,
              name: resolvedOffer.name,
              rewardType: resolvedOffer.rewardType,
            }
          }
        } else {
          // Nothing currently qualifies (or the best fit isn't auto-apply) —
          // see if there's a nearby offer worth teasing instead, e.g. "Add
          // Fresh Vegetables worth ₹150 more to unlock Free Delivery!" A
          // customer whose cart just doesn't match any offer's scope would
          // otherwise never learn these offers exist at all.
          const upcoming = await this.firstTimeOffersService.previewUpcoming(
            userId,
            itemTotalDiscounted,
            { cartItems: shopGroups[0].items }
          )
          if (upcoming) {
            firstTimeOfferTeaser = {
              id: upcoming.id,
              name: upcoming.name,
              rewardType: upcoming.rewardType,
              amountToUnlock: upcoming.amountToUnlock,
              message: await this.firstTimeOffersService.describeUpcoming(upcoming),
            }
          }
        }
      } catch (err) {
        logger.warn({ userId, err: err.message, action: 'bill_summary_first_time_offer' }, 'First-time offer resolve failed')
      }
    }

    // Cart milestone reward — resolved here (not just at order placement) so
    // a milestone that grants free delivery OR an instant discount
    // (FLAT_DISCOUNT — "Instant Discount" in the dashboard) is reflected in
    // what the customer SEES while shopping, matching what order placement
    // will actually charge. Previously this only fed free delivery through;
    // the discount portion was computed here but silently dropped, so a
    // milestone crossing ₹49 promised an instant discount that never showed
    // up until the order confirmation screen — only orders.service.js ever
    // applied it, and only at the very end. Best-effort: a milestone lookup
    // failure must never break the cart summary itself.
    // A cart-milestone scope (applicable_category_ids/applicable_product_ids,
    // 103_cart_milestone_scope.sql) is evaluated against the actual cart
    // lines, not just the aggregate total — same as coupons/first-time-offers.
    // Unlike those two, cart milestones aren't restricted to single-shop
    // carts for FREE DELIVERY/CASHBACK/COUPON_UNLOCK (the aggregate
    // itemTotalDiscounted already spans every shop) — but the discount
    // portion specifically still is, same as OrdersService.placeOrder()'s
    // "single discount slot" rule below (order-splitter.service.js's fee
    // engine only ever discounts one shop's order, and a manually-typed
    // coupon isn't known yet at cart-view time so first-time-offer is the
    // only other slot-occupant this preview needs to check against).
    const allCartItems = shopGroups.flatMap((g) => g.items || [])
    let cartMilestoneProgress = { unlocked: null, next: null }
    let eligibleMilestoneTiers = []
    let cartMilestoneFreeDelivery = false
    let cartMilestoneDiscount = 0
    let cartMilestoneDiscountMeta = null
    try {
      const [progress, eligibleTiers] = await Promise.all([
        this.cartMilestonesService.getProgress(userId, itemTotalDiscounted, allCartItems),
        this.cartMilestonesService.getEligibleTiers(userId, itemTotalDiscounted, allCartItems),
      ])
      cartMilestoneProgress = progress
      eligibleMilestoneTiers = eligibleTiers
      if (progress.unlocked) {
        const reward = this.cartMilestonesService.computeReward(progress.unlocked, itemTotalDiscounted)
        // BUG FIX: mirror OrdersService.placeOrder()'s explicit, documented
        // restriction on the FREE_DELIVERY portion of a cart-milestone
        // reward — order-splitter.service.js's waiver mechanism targets
        // exactly one shop (`feeContext.freeDeliveryShopId`), so a
        // milestone's free delivery can only ever be honored on a
        // single-shop cart at checkout (see orders.service.js's
        // `freeDeliveryApplied = isSingleShop && reward.freeDelivery`).
        // Previously this was unconditional here, so a multi-shop cart's
        // live preview showed "Free delivery unlocked" / ₹0 delivery fee
        // for every shop once a milestone was crossed, while checkout then
        // silently charged the FULL delivery fee on every shop's split
        // order — the exact "shown one total, charged another" divergence
        // reported by customers. The DISCOUNT portion already had this
        // same single-shop gate (below); free delivery was the gap.
        cartMilestoneFreeDelivery = shopGroups.length === 1 && !!reward.freeDelivery
        if (reward.discount && shopGroups.length === 1 && !firstTimeOfferDiscount) {
          cartMilestoneDiscount = this._round(reward.discount)
          cartMilestoneDiscountMeta = { id: progress.unlocked.id, name: progress.unlocked.name }
        }
      }
    } catch (err) {
      logger.warn({ userId, err: err.message, action: 'bill_summary_milestone' }, 'Cart milestone progress failed')
    }
    const forceFreeDelivery = firstTimeOfferFreeDelivery || cartMilestoneFreeDelivery
    // Combined "single discount slot" total — same convention
    // OrdersService.placeOrder() uses (coupon/first-time-offer/cart-
    // milestone discounts never stack; here only first-time-offer and
    // cart-milestone can compete, since a manually-typed coupon code isn't
    // known at cart-view time). Replaces the old bare `firstTimeOfferDiscount`
    // everywhere below so a milestone discount reduces the shown total too.
    const autoAppliedDiscount = this._round(firstTimeOfferDiscount + cartMilestoneDiscount)

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
    // Per-shop GST sum — see the multi-shop GST note below for why this is
    // only used (instead of the single blanket gst_rate) when the cart
    // spans more than one shop.
    let gstFromShops = 0

    // Single-shop carts already resolved this exact shop's config above
    // (`resolvedShopConfig`) — reuse it instead of querying the identical
    // row again. Multi-shop carts genuinely need one resolution per shop
    // (STORE override can differ per shop), so those run in parallel rather
    // than as N sequential round trips inside the loop below.
    const perShopConfigs =
      shopGroups.length === 1
        ? [resolvedShopConfig]
        : await Promise.all(
            shopGroups.map((group) => this.feeSettingsService.resolveForShop(group.shopId))
          )

    for (let i = 0; i < shopGroups.length; i++) {
      const group = shopGroups[i]
      const meta = shopMeta.get(group.shopId) || {}
      const distanceKm =
        address && Number.isFinite(meta.lat) && Number.isFinite(meta.lng)
          ? haversineKm(address.lat, address.lng, meta.lat, meta.lng)
          : null

      const shopConfigResolved = perShopConfigs[i]
      const breakdown = this.totalsEngine.computeBreakdown({
        config: shopConfigResolved.config,
        itemsSubtotal: group.subtotal,
        distanceKm,
        storeName: meta.name || group.shopName || null,
        forceFreeDelivery,
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
      // This per-shop breakdown never carries a discount (autoAppliedDiscount
      // only ever applies on single-shop carts — see the discount-slot gates
      // above), so `breakdown.tax` here is already exactly what
      // order-splitter.service.js would charge for this shop's own GST
      // (computed from THIS shop's own resolved config, not a blanket rate).
      gstFromShops = this._round(gstFromShops + breakdown.tax)

      // Use the primary (first / single) shop for the headline distance label.
      if (primaryDistanceKm === null && breakdown.distance.known) {
        primaryDistanceKm = breakdown.distance.km
        primaryStoreName = meta.name || group.shopName || null
      }
    }

    // Build a single aggregate breakdown for the canonical response. The
    // first-time-offer + cart-milestone discount is fed through the
    // engine's `couponDiscount` slot — the same "single discount slot"
    // convention OrdersService.placeOrder() already uses (coupon,
    // first-time-offer, and cart-milestone discounts share one slot, never
    // stack) — so totalPayable/totalSavings stay consistent.
    const aggregate = this.totalsEngine.computeBreakdown({
      config,
      itemsSubtotal: itemTotalDiscounted,
      itemDiscount: mrpDiscount,
      couponDiscount: autoAppliedDiscount,
      distanceKm: primaryDistanceKm,
      tipAmount: chargeableTipAmount,
      storeName: primaryStoreName,
      quickDeliverySelected: chargeableQuickDeliverySelected,
      forceFreeDelivery,
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

    // Quick Delivery surcharge is order-level (not per-shop-distance like
    // delivery fee), so the aggregate breakdown's own value is authoritative
    // — no per-shop summing needed, unlike the fees above.
    const quickDeliverySurcharge = aggregate.quickDeliverySurcharge || 0

    const feesTotal = this._round(
      deliveryFee + handlingFee + platformFee + smallCartFee + surgeFee + packagingFee + quickDeliverySurcharge
    )

    // GST — exclusive, computed on (subtotal + all other fees), matching
    // TotalsEngine.computeBreakdown's formula. Recomputed here (rather than
    // trusting the single-shop `aggregate.tax` from the earlier
    // computeBreakdown call above) because this method overwrites every
    // other fee with the properly-summed multi-shop total — using the
    // stale single-shop tax figure would under/over-charge on any
    // multi-shop cart.
    //
    // BUG FIX: a multi-shop cart used a single blanket `config.gst_rate`
    // (the GLOBAL config, since `config` resolves to shopId=null when there
    // is more than one shop) applied to the WHOLE combined pre-tax total.
    // fee_settings supports a per-shop STORE override of gst_enabled/
    // gst_rate, and order-splitter.service.js's actual charge computes GST
    // per shop through TotalsEngine using THAT shop's own resolved config
    // (see OrderSplitterService#computeShopFees) — so a shop with a
    // different GST override than GLOBAL (or than a sibling shop) made this
    // preview's tax diverge from what checkout actually charges. The
    // per-shop loop above already computed each shop's own correct GST
    // (`gstFromShops`) via each shop's own resolved config; a cross-shop
    // discount never applies on a multi-shop cart (auto-applied discounts
    // are single-shop-only — see the discount-slot gates above), so that
    // per-shop sum needs no further discount adjustment and is exactly what
    // gets charged. Single-shop carts are unaffected — `config` there IS
    // that one shop's own resolved config, so the blanket formula (which
    // also correctly folds in the real discount) already matches.
    let gstAmount
    if (shopGroups.length === 1) {
      const preTaxTotal = this._round(
        Math.max(0, itemTotalDiscounted - autoAppliedDiscount + feesTotal)
      )
      gstAmount = config.gst_enabled
        ? this._round((preTaxTotal * this._toNumber(config.gst_rate)) / 100)
        : 0
    } else {
      gstAmount = gstFromShops
    }
    aggregate.tax = gstAmount

    const toPayFinal = this._round(
      Math.max(0, itemTotalDiscounted - autoAppliedDiscount + feesTotal + gstAmount + chargeableTipAmount)
    )
    const toPayOriginal = this._round(
      itemTotalOriginal + deliveryFeeOriginal + handlingFee + platformFee + smallCartFee + surgeFee + packagingFee + quickDeliverySurcharge + gstAmount + chargeableTipAmount
    )
    aggregate.totalPayable = toPayFinal
    aggregate.itemsSubtotal = itemTotalDiscounted
    aggregate.itemDiscount = mrpDiscount

    // BUG FIX: recompute totalSavings from the properly-summed multi-shop
    // delivery figures instead of trusting the value TotalsEngine returned
    // inside the single `computeBreakdown` call above. That call only ever
    // saw ONE shop's distance (`primaryDistanceKm`) and, for a multi-shop
    // cart, the GLOBAL config rather than each shop's own resolved config —
    // so its internal delivery-waiver "original fee" was neither the right
    // per-shop amount nor the right sum. `aggregate.deliveryFeeOriginal`/
    // `deliveryFeeWaived` were already corrected above (from the per-shop
    // loop's real sums); `totalSavings` needs the same correction or a
    // multi-shop order's "You saved ₹X" figure silently understates or
    // overstates the real delivery discount whenever delivery is waived.
    const deliverySaving = aggregate.deliveryFeeWaived ? deliveryFeeOriginal : 0
    aggregate.totalSavings = this._round(mrpDiscount + autoAppliedDiscount + deliverySaving)

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
      quickDeliverySurcharge,
      gstAmount,
      distanceKm: primaryDistanceKm,
      storeName: primaryStoreName,
      amountToUnlock,
    })

    const { normalEtaMinutes, quickEtaMinutes, deliveryEstimateMinutes } =
      this._resolveDeliveryEstimateMinutes(config, chargeableQuickDeliverySelected)
    const freeThreshold = aggregate.freeDelivery.threshold

    // Cart milestone progress (Phase 3) — powers the mobile Smart Bottom
    // Bar's "Add ₹X more to unlock…" state, plus a full merged ladder (free
    // delivery + every cart-milestone tier this user is eligible for, in
    // one ascending sequence) so the bar can render a single segmented
    // progress track instead of resetting to 0% every time a tier is
    // crossed — each tier fills its own segment as the cart approaches it,
    // and every earlier segment stays fully filled once passed.
    // Reuses the progress/tiers already resolved above (for forceFreeDelivery)
    // instead of re-querying them.
    // The global free-delivery threshold only joins the ladder as its own
    // checkpoint when explicitly opted in (free_delivery_in_milestone_ladder)
    // — otherwise a shop with one real cart milestone would see what looks
    // like two milestones in the progress track. This is purely a display
    // decision: the threshold's own "Add ₹X more to unlock FREE DELIVERY"
    // banner (freeDelivery.amountToUnlock above) and the actual fee waiver
    // are computed the same either way.
    const cartMilestone = {
      ...cartMilestoneProgress,
      ladder: this._buildRewardLadder({
        freeDeliveryEnabled: aggregate.freeDelivery.enabled && !!config.free_delivery_in_milestone_ladder,
        freeDeliveryThreshold: freeThreshold,
        tiers: eligibleMilestoneTiers,
        cartTotal: itemTotalDiscounted,
      }),
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
        label: config.handling_fee_label || 'Handling fee',
        description: config.handling_fee_description || 'Covers packing and order handling.',
      },
      lateNightFee: {
        amount: 0,
        isFree: true,
        savedAmount: 0,
        isLateNight: false,
      },
      // Auto-applied first-time-offer or cart-milestone discount (backend-
      // known at cart-view time — no customer action needed; the two never
      // stack, same single-discount-slot rule as OrdersService.placeOrder()).
      // A manually-typed coupon code lives entirely in client-side state
      // and is NOT reflected here; the Flutter app overlays that discount
      // on top of / in place of this one (a manual coupon takes priority).
      couponDiscount: autoAppliedDiscount,
      // Reflects what will actually be CHARGED (0 for a multi-shop cart —
      // see chargeableTipAmount above), not necessarily the raw tip value
      // still sitting in Redis from a single-shop session — so this field
      // always agrees with toPay.final/totals.tipAmount.
      tipAmount: chargeableTipAmount,
      toPay: {
        original: toPayOriginal,
        final: toPayFinal,
      },
      savings: {
        total: aggregate.totalSavings,
        breakdown: [
          ...(mrpDiscount > 0
            ? [{ type: 'mrp_discount', label: 'Discount on MRP', amount: mrpDiscount }]
            : []),
          ...(firstTimeOfferDiscount > 0
            ? [{ type: 'first_time_offer', label: firstTimeOfferMeta?.name || 'First order offer', amount: firstTimeOfferDiscount }]
            : []),
          ...(cartMilestoneDiscount > 0
            ? [{ type: 'cart_milestone', label: cartMilestoneDiscountMeta?.name || 'Milestone discount', amount: cartMilestoneDiscount }]
            : []),
        ],
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
      platformFee: {
        amount: platformFee,
        isFree: platformFee <= 0,
        label: config.platform_fee_label || 'Platform fee',
        description: config.platform_fee_description || 'Supports platform operations and support.',
      },
      smallCartFee: {
        amount: smallCartFee,
        isFree: smallCartFee <= 0,
        label: config.small_cart_fee_label || 'Small cart fee',
        description: config.small_cart_fee_description || 'Applied to small orders.',
      },
      totalPayable: toPayFinal,
      paymentMethods: this._buildPaymentMethods(paymentConfig, toPayFinal),
      cartMilestone,
      firstTimeOffer: firstTimeOfferMeta
        ? {
            id: firstTimeOfferMeta.id,
            name: firstTimeOfferMeta.name,
            rewardType: firstTimeOfferMeta.rewardType,
            discount: firstTimeOfferDiscount,
            freeDelivery: firstTimeOfferFreeDelivery,
          }
        : null,
      // Positive nudge shown instead of firstTimeOffer when nothing
      // currently qualifies but a nearby offer exists — see the resolve
      // block above. Always null whenever firstTimeOffer is non-null.
      firstTimeOfferTeaser,
      // Whether the "Quick Delivery" opt-in is available at all right now —
      // independent of the fees[] line, which only appears once the
      // customer has actually selected it (see quickDeliverySelected param).
      quickDelivery: {
        enabled: !!config.quick_delivery_surcharge_enabled,
        amount: this._toNumber(config.quick_delivery_surcharge_amount) || 0,
        label: config.quick_delivery_surcharge_label || 'Quick delivery fee',
        etaMinutes: quickEtaMinutes,
      },
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

  /**
   * Resolve which delivery estimate to show: the normal always-shown
   * `delivery_eta_minutes`, or — once the customer has actually opted into
   * (and is paying for) Quick Delivery — the faster `quick_delivery_eta_minutes`.
   * Never switches just because the surcharge is enabled in config; only
   * when the customer explicitly selected it for this request.
   */
  _resolveDeliveryEstimateMinutes(config, quickDeliverySelected) {
    const normalEtaMinutes = this._toNumber(config.delivery_eta_minutes) || 30
    const quickEtaMinutes = this._toNumber(config.quick_delivery_eta_minutes) || normalEtaMinutes
    const quickDeliveryApplied = quickDeliverySelected && !!config.quick_delivery_surcharge_enabled
    return {
      normalEtaMinutes,
      quickEtaMinutes,
      deliveryEstimateMinutes: quickDeliveryApplied ? quickEtaMinutes : normalEtaMinutes,
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
    quickDeliverySurcharge = 0,
    gstAmount = 0,
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
    if (quickDeliverySurcharge > 0) {
      fees.push({
        code: 'QUICK_DELIVERY_SURCHARGE',
        label: config.quick_delivery_surcharge_label || 'Quick delivery fee',
        amount: quickDeliverySurcharge,
        originalAmount: quickDeliverySurcharge,
        waived: false,
        description: 'Charged for immediate/priority delivery.',
        metadata: {},
      })
    }
    if (gstAmount > 0) {
      fees.push({
        code: 'GST',
        label: config.gst_label || 'GST',
        amount: gstAmount,
        originalAmount: gstAmount,
        waived: false,
        description: `${config.gst_rate}% tax on the order total.`,
        metadata: { rate: this._toNumber(config.gst_rate) },
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
        amount: cartTotal,
      })
    }
    for (const tier of tiers) {
      checkpoints.push({
        id: tier.id,
        label: tier.name,
        minAmount: this._round(tier.minCartAmount),
        // A category/product-scoped tier (103_cart_milestone_scope.sql)
        // fills based on only the matching slice of the cart — see
        // CartMilestonesService#_scopedSubtotal, already resolved onto each
        // tier by getEligibleTiers. Falls back to the plain cart total for
        // an unscoped tier, so existing unscoped milestones render exactly
        // as before.
        amount: tier.scopedSubtotal ?? cartTotal,
      })
    }
    checkpoints.sort((a, b) => a.minAmount - b.minAmount)

    let previousAmount = 0
    return checkpoints.map((checkpoint) => {
      const span = checkpoint.minAmount - previousAmount
      const achieved = checkpoint.amount >= checkpoint.minAmount
      const segmentProgress = achieved
        ? 1
        : span > 0
          ? Math.max(0, Math.min(1, (checkpoint.amount - previousAmount) / span))
          : 0
      previousAmount = checkpoint.minAmount
      return {
        id: checkpoint.id,
        label: checkpoint.label,
        minAmount: checkpoint.minAmount,
        achieved,
        segmentProgress: this._round(segmentProgress),
      }
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
      quickDelivery: { enabled: false, amount: 0, label: 'Quick delivery fee', etaMinutes: 0 },
      firstTimeOffer: null,
      firstTimeOfferTeaser: null,
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
