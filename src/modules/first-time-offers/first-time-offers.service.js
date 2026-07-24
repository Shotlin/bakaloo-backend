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
   * user isn't first-time or no offer matches. This is the single source
   * of truth both the checkout flow and any "eligible offer" preview
   * should call — never re-derive first-order status separately.
   */
  async resolveForCheckout(userId, cartTotal, { onlinePayment } = {}) {
    const hasPriorOrder = await this.repo.hasPriorOrder(userId)
    if (hasPriorOrder) return null
    return this.repo.findBestFitActive(cartTotal, { onlinePayment })
  }

  /**
   * Translate an offer + cart total into a concrete reward effect.
   * Mirrors the coupon discount calculation (Math.min cap, maxDiscount cap)
   * for consistency between the two reward systems.
   */
  computeReward(offer, cartTotal) {
    switch (offer.rewardType) {
      case 'FREE_DELIVERY':
        return { freeDelivery: true }
      case 'FLAT_DISCOUNT':
        return { discount: Math.min(offer.rewardValue || 0, cartTotal) }
      case 'PERCENTAGE_DISCOUNT': {
        let discount = (cartTotal * (offer.rewardValue || 0)) / 100
        if (offer.maxDiscount) discount = Math.min(discount, offer.maxDiscount)
        return { discount: Math.min(discount, cartTotal) }
      }
      case 'WALLET_CASHBACK':
        return { cashbackAmount: offer.rewardValue || 0 }
      case 'COUPON_UNLOCK':
        return { unlockCouponId: offer.unlockCouponId }
      default:
        return {}
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
