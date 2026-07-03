import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { CartMilestonesRepository } from './cart-milestones.repository.js'
import { CustomerSegmentsRepository } from '../admin/customer-segments/customer-segments.repository.js'

export class CartMilestonesService {
  constructor(
    repository = new CartMilestonesRepository(),
    segmentsRepo = new CustomerSegmentsRepository()
  ) {
    this.repo = repository
    this.segmentsRepo = segmentsRepo
  }

  async listAll() {
    return this.repo.findAll()
  }

  async getDetail(id) {
    return this.repo.findById(id)
  }

  /** Is this milestone visible/applicable to this user at all (independent of cart value)? */
  async _isEligible(milestone, userId) {
    if (milestone.applicableUserType === 'FIRST_TIME') {
      return !(await this.repo.hasPriorOrder(userId))
    }
    if (milestone.applicableUserType === 'SEGMENT') {
      return milestone.applicableSegmentId
        ? this.segmentsRepo.isMember(milestone.applicableSegmentId, userId)
        : false
    }
    return true
  }

  /** All active milestones this user is eligible for, ordered ascending by tier — the raw ladder, independent of cart value. */
  async getEligibleTiers(userId) {
    const active = await this.repo.findAllActive()
    const eligible = []
    for (const m of active) {
      if (await this._isEligible(m, userId)) eligible.push(m)
    }
    return eligible
  }

  /**
   * Build the "next milestone" progress for the Smart Bottom Bar / bill
   * summary: the highest tier already unlocked by the current cart value
   * (if any) and the lowest tier still ahead (if any), both scoped to
   * milestones this user is actually eligible for.
   */
  async getProgress(userId, cartTotal) {
    const eligible = await this.getEligibleTiers(userId)

    let unlockedMilestone = null
    let nextMilestone = null
    for (const m of eligible) {
      if (m.minCartAmount <= cartTotal) {
        // Tiers are ordered ascending, so the last one that fits is the best.
        unlockedMilestone = m
      } else if (!nextMilestone) {
        nextMilestone = m
      }
    }

    return {
      unlocked: unlockedMilestone
        ? { ...unlockedMilestone, message: unlockedMilestone.messageAfter || `${unlockedMilestone.name} unlocked` }
        : null,
      next: nextMilestone
        ? {
            ...nextMilestone,
            amountToUnlock: Math.round((nextMilestone.minCartAmount - cartTotal) * 100) / 100,
            message: this._renderMessage(nextMilestone, cartTotal),
          }
        : null,
    }
  }

  _renderMessage(milestone, cartTotal) {
    const amountToUnlock = Math.round((milestone.minCartAmount - cartTotal) * 100) / 100
    const template = milestone.messageBefore || `Add ₹{amount} more to unlock {name}`
    return template
      .replace('{amount}', String(amountToUnlock))
      .replace('{name}', milestone.name)
  }

  /** Resolve the best-fit (highest unlocked) milestone reward for checkout, or null. */
  async resolveForCheckout(userId, cartTotal) {
    const progress = await this.getProgress(userId, cartTotal)
    return progress.unlocked
  }

  /** Mirrors FirstTimeOffersService.computeReward — same shape convention. */
  computeReward(milestone, cartTotal) {
    switch (milestone.rewardType) {
      case 'FLAT_DISCOUNT':
        return { discount: Math.min(milestone.rewardValue || 0, cartTotal) }
      case 'CASHBACK': {
        let amount = milestone.rewardValue || 0
        if (milestone.maxDiscount) amount = Math.min(amount, milestone.maxDiscount)
        return { cashbackAmount: amount }
      }
      case 'COUPON_UNLOCK':
        return { unlockCouponId: milestone.unlockCouponId }
      default:
        return {}
    }
  }

  async create(data, actor) {
    if (!data.name || !data.rewardType || data.minCartAmount == null) {
      return { success: false, message: 'name, rewardType and minCartAmount are required' }
    }
    const milestone = await this.repo.create({ ...data, createdBy: actor.userId })
    emitAudit('cart_milestone_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'cart_milestone',
      target_id: milestone.id,
      before: null,
      after: milestone,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    logger.info({ milestoneId: milestone.id, actor: actor.userId }, 'Cart milestone created')
    return { success: true, milestone }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Milestone not found' }
    const milestone = await this.repo.update(id, data)
    emitAudit('cart_milestone_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'cart_milestone',
      target_id: id,
      before: existing,
      after: milestone,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, milestone }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Milestone not found' }
    await this.repo.delete(id)
    emitAudit('cart_milestone_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'cart_milestone',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }
}
