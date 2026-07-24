import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { FirstTimeOffersRepository } from './first-time-offers.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'

export class FirstTimeOffersService {
  constructor(repository = new FirstTimeOffersRepository(), couponsRepo = new CouponsRepository()) {
    this.repo = repository
    this.couponsRepo = couponsRepo
  }

  async listAll() {
    return this.repo.findAll()
  }

  async getDetail(id) {
    return this.repo.findById(id)
  }

  /**
   * Resolve the best-fit first-time offer for a checkout, or null if the
   * user isn't first-time or no offer currently qualifies. This is the
   * single source of truth both the checkout flow and the cart preview
   * should call — never re-derive first-order status separately.
   *
   * @param {string} userId
   * @param {number} cartTotal
   * @param {{onlinePayment?: boolean, cartItems?: Array<object>}} [opts] -
   *   cartItems (single shop's worth) is only needed when an active offer
   *   has a category/product scope; omit it and every scoped offer simply
   *   won't be satisfiable (same fail-safe as coupons.service.js).
   */
  async resolveForCheckout(userId, cartTotal, { onlinePayment, cartItems = null } = {}) {
    const hasPriorOrder = await this.repo.hasPriorOrder(userId)
    if (hasPriorOrder) return null
    const { best } = await this._evaluateCandidates(cartTotal, cartItems, { onlinePayment })
    return best
  }

  /**
   * The closest not-yet-satisfied active offer, for a positive "add X to
   * unlock this offer" nudge on the cart screen — e.g. a customer whose
   * cart is all dairy gets told exactly which category to add to unlock a
   * Fresh Vegetables-scoped offer, instead of the offer just silently never
   * appearing anywhere. Returns null when the user isn't first-time, when
   * an offer is already satisfied (resolveForCheckout handles that — a
   * "you got X" and "add Y to get Z" message at the same time would be a
   * confusing double message), or when there's simply nothing active to
   * work toward.
   */
  async previewUpcoming(userId, cartTotal, { onlinePayment, cartItems = null } = {}) {
    const hasPriorOrder = await this.repo.hasPriorOrder(userId)
    if (hasPriorOrder) return null
    const { best, closest } = await this._evaluateCandidates(cartTotal, cartItems, { onlinePayment })
    if (best) return null
    return closest
  }

  /**
   * Evaluates every active/date/payment-valid offer against the cart,
   * splitting them into the best currently-satisfied one (highest
   * min_order_amount whose scoped subtotal clears it — the same "bigger
   * order, better reward" tie-break the old SQL-only version used) and the
   * closest not-yet-satisfied one (smallest gap between min_order_amount
   * and what the cart currently contributes toward it).
   */
  async _evaluateCandidates(cartTotal, cartItems, { onlinePayment } = {}) {
    const candidates = await this.repo.findAllActiveCandidates({ onlinePayment })
    let best = null
    let closest = null
    let closestGap = Infinity

    for (const offer of candidates) {
      const hasScope = (offer.applicableCategoryIds?.length > 0) || (offer.applicableProductIds?.length > 0)
      let scopedSubtotal = cartTotal
      if (hasScope) {
        const items = cartItems || []
        const matchingIds = await this.repo.resolveMatchingProductIds(
          items.map((i) => i.productId),
          { applicableCategoryIds: offer.applicableCategoryIds, applicableProductIds: offer.applicableProductIds }
        )
        scopedSubtotal = parseFloat(
          items
            .filter((i) => matchingIds.has(i.productId))
            .reduce((sum, i) => sum + Number(i.lineTotal ?? i.effectivePrice * i.quantity), 0)
            .toFixed(2)
        )
      }

      if (scopedSubtotal >= offer.minOrderAmount) {
        if (!best || offer.minOrderAmount > best.minOrderAmount) {
          best = { ...offer, scopedSubtotal }
        }
        continue
      }

      const gap = parseFloat((offer.minOrderAmount - scopedSubtotal).toFixed(2))
      if (gap < closestGap) {
        closestGap = gap
        closest = { ...offer, scopedSubtotal, amountToUnlock: gap, hasScope }
      }
    }

    return { best, closest }
  }

  /**
   * Translate an offer + cart total into a concrete reward effect.
   * Mirrors the coupon discount calculation (Math.min cap, maxDiscount cap,
   * scopedSubtotal in place of the raw cart total when the offer has a
   * category/product scope) for consistency between the two systems.
   */
  computeReward(offer, cartTotal) {
    const amount = offer.scopedSubtotal ?? cartTotal
    // grantsFreeDelivery is independent of rewardType (090_first_time_offer_
    // scope_and_free_delivery.sql) — ORed with the legacy rewardType ===
    // 'FREE_DELIVERY' path so existing offers of that type keep behaving
    // exactly as before, while e.g. a WALLET_CASHBACK offer can now ALSO
    // waive delivery instead of being forced to choose one or the other.
    const freeDelivery = offer.rewardType === 'FREE_DELIVERY' || !!offer.grantsFreeDelivery
    switch (offer.rewardType) {
      case 'FREE_DELIVERY':
        return { freeDelivery }
      case 'FLAT_DISCOUNT':
        return { discount: Math.min(offer.rewardValue || 0, amount), freeDelivery }
      case 'PERCENTAGE_DISCOUNT': {
        let discount = (amount * (offer.rewardValue || 0)) / 100
        if (offer.maxDiscount) discount = Math.min(discount, offer.maxDiscount)
        return { discount: Math.min(discount, amount), freeDelivery }
      }
      case 'WALLET_CASHBACK':
        return { cashbackAmount: offer.rewardValue || 0, freeDelivery }
      case 'COUPON_UNLOCK':
        return { unlockCouponId: offer.unlockCouponId, freeDelivery }
      default:
        return { freeDelivery }
    }
  }

  /**
   * "Add X to unlock this offer" copy for the cart-screen teaser — names
   * the actual category/products a scoped offer needs (mirrors
   * CouponsService#_buildScopeMismatchMessage, positively framed), or the
   * plain rupee shortfall for an unscoped offer.
   */
  async describeUpcoming(offer) {
    const rewardLabel = this._rewardLabel(offer)
    if (!offer.hasScope) {
      return `Add ₹${offer.amountToUnlock} more to unlock ${rewardLabel}!`
    }
    const [categoryNames, productNames] = await Promise.all([
      this.repo.getCategoryNames(offer.applicableCategoryIds || []),
      this.repo.getProductNames(offer.applicableProductIds || []),
    ])
    const names = [...categoryNames, ...productNames]
    if (names.length === 0) {
      return `Add ₹${offer.amountToUnlock} more of the right products to unlock ${rewardLabel}!`
    }
    const shown = names.slice(0, 3).join(', ')
    const label = names.length > 3 ? `${shown} & more` : shown
    return `Add ₹${offer.amountToUnlock} of ${label} to unlock ${rewardLabel}!`
  }

  _rewardLabel(offer) {
    switch (offer.rewardType) {
      case 'FREE_DELIVERY':
        return 'Free Delivery'
      case 'FLAT_DISCOUNT':
        return `₹${offer.rewardValue} off`
      case 'PERCENTAGE_DISCOUNT':
        return `${offer.rewardValue}% off`
      case 'WALLET_CASHBACK':
        return `₹${offer.rewardValue} cashback`
      case 'COUPON_UNLOCK':
        return 'a special coupon'
      default:
        return offer.name
    }
  }

  /**
   * Same gap as cart-milestones.service.js#_validateCouponUnlock: a
   * COUPON_UNLOCK reward only takes effect via coupon_target_users, which
   * coupons.service.js#_isTargetEligible only consults when the coupon's
   * targetType is 'INDIVIDUAL'. Any other targetType makes the "unlock" a
   * silent no-op.
   */
  async _validateCouponUnlock(data) {
    if (data.rewardType !== 'COUPON_UNLOCK') return null
    if (!data.unlockCouponId) {
      return 'unlockCouponId is required when rewardType is COUPON_UNLOCK'
    }
    const coupon = await this.couponsRepo.findById(data.unlockCouponId)
    if (!coupon) return 'Selected coupon was not found'
    if (coupon.targetType !== 'INDIVIDUAL') {
      return `"${coupon.code}" must have its Target Audience set to "Individual" to work as a first-time-offer reward — it's currently "${coupon.targetType}", so unlocking it would have no effect on who can use it.`
    }
    if (!coupon.isActive) {
      return `"${coupon.code}" is inactive — activate it before linking it as a first-time-offer reward.`
    }
    return null
  }

  async create(data, actor) {
    if (!data.name || !data.rewardType) {
      return { success: false, message: 'name and rewardType are required' }
    }
    const couponError = await this._validateCouponUnlock(data)
    if (couponError) return { success: false, message: couponError }
    const offer = await this.repo.create({ ...data, createdBy: actor.userId })
    emitAudit('first_time_offer_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'first_time_offer',
      target_id: offer.id,
      before: null,
      after: offer,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    logger.info({ offerId: offer.id, actor: actor.userId }, 'First-time offer created')
    return { success: true, offer }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Offer not found' }
    const merged = { ...existing, ...data }
    const couponError = await this._validateCouponUnlock(merged)
    if (couponError) return { success: false, message: couponError }
    const offer = await this.repo.update(id, data)
    emitAudit('first_time_offer_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'first_time_offer',
      target_id: id,
      before: existing,
      after: offer,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, offer }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Offer not found' }
    await this.repo.delete(id)
    emitAudit('first_time_offer_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'first_time_offer',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }
}
