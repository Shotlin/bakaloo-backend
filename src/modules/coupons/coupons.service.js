import { logger } from '../../config/logger.js'
import { getOffsetLimit } from '../../utils/paginate.js'
import { findDemoCouponByCode, mergeDemoCoupons } from './demo-coupons.js'

/**
 * Coupons service — business logic for discount codes
 */
export class CouponsService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Validate a coupon code against a cart total
   */
  async validate(userId, code, cartTotal) {
    const coupon = (await this.repo.findByCode(code)) ?? findDemoCouponByCode(code)

    if (!coupon) {
      return { valid: false, message: 'Coupon not found' }
    }
    if (!coupon.isActive) {
      return { valid: false, message: 'Coupon is no longer active' }
    }

    const now = new Date()
    if (coupon.validFrom && new Date(coupon.validFrom) > now) {
      return { valid: false, message: 'Coupon is not yet active' }
    }
    if (coupon.validUntil && new Date(coupon.validUntil) < now) {
      return { valid: false, message: 'Coupon has expired' }
    }

    // Global usage limit
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      return { valid: false, message: 'Coupon usage limit reached' }
    }

    // Per-user limit
    const userUsage = coupon.isDemo
      ? 0
      : await this.repo.getUserUsageCount(coupon.id, userId)
    if (userUsage >= coupon.perUserLimit) {
      return { valid: false, message: 'You have already used this coupon' }
    }

    // Minimum order amount
    if (cartTotal < coupon.minOrderAmount) {
      return {
        valid: false,
        message: `Minimum order amount is ₹${coupon.minOrderAmount}`,
      }
    }

    // Calculate discount
    let discount = 0
    if (coupon.discountType === 'PERCENTAGE') {
      discount = (cartTotal * coupon.discountValue) / 100
      if (coupon.maxDiscount && discount > coupon.maxDiscount) {
        discount = coupon.maxDiscount
      }
    } else {
      discount = coupon.discountValue
    }

    discount = parseFloat(Math.min(discount, cartTotal).toFixed(2))

    return {
      valid: true,
      discount,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      description: coupon.description ?? null,
      terms: coupon.terms ?? null,
      minOrderAmount: coupon.minOrderAmount || 0,
      maxDiscount: coupon.maxDiscount || null,
      code: coupon.code,
      couponId: coupon.id,
    }
  }

  /**
   * Get available coupons for a user (filter out maxed-out ones)
   */
  async getAvailable(userId) {
    const coupons = mergeDemoCoupons(await this.repo.findAvailable())
    const available = []

    for (const coupon of coupons) {
      const usage = coupon.isDemo
        ? 0
        : await this.repo.getUserUsageCount(coupon.id, userId)
      if (usage < coupon.perUserLimit) {
        available.push(this._toPublicCoupon(coupon))
      }
    }

    return available
  }

  /**
   * Record that a coupon was used in an order
   */
  async recordUsage(couponCode, userId, orderId) {
    const coupon = await this.repo.findByCode(couponCode)
    if (coupon) {
      await this.repo.recordUsage(coupon.id, userId, orderId)
      logger.info({ couponId: coupon.id, userId, orderId }, 'Coupon usage recorded')
    }
  }

  // ─── ADMIN methods ─────────────────────────────────────

  async listAll(filters) {
    return this.repo.findAll(filters)
  }

  async create(data) {
    const existing = await this.repo.findByCode(data.code)
    if (existing) {
      return { success: false, message: 'Coupon code already exists' }
    }

    const coupon = await this.repo.create(data)
    logger.info({ couponId: coupon.id, code: coupon.code }, 'Coupon created')
    return { success: true, coupon }
  }

  async update(id, data) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Coupon not found' }
    }

    if (data.code && data.code.toUpperCase() !== existing.code) {
      const dup = await this.repo.findByCode(data.code)
      if (dup) {
        return { success: false, message: 'Coupon code already exists' }
      }
    }

    const coupon = await this.repo.update(id, data)
    logger.info({ couponId: id }, 'Coupon updated')
    return { success: true, coupon }
  }

  async delete(id) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Coupon not found' }
    }

    await this.repo.delete(id)
    logger.info({ couponId: id }, 'Coupon deleted')
    return { success: true }
  }

  _toPublicCoupon(coupon) {
    return {
      ...coupon,
      discountAmount: this._bestDisplayDiscount(coupon),
      terms: coupon.terms ?? null,
    }
  }

  _bestDisplayDiscount(coupon) {
    if (coupon.discountType === 'PERCENTAGE') {
      return coupon.maxDiscount || coupon.discountValue || 0
    }
    return coupon.discountValue || 0
  }
}
