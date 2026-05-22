import { CartRepository } from './cart.repository.js'
import { CartService } from './cart.service.js'
import { FeeConfigRepository } from '../fee-config/fee-config.repository.js'
import { FeeConfigService } from '../fee-config/fee-config.service.js'

/**
 * Bill summary service — computes complete cart bill breakdown
 * Used by GET /api/v1/cart/summary
 */
export class BillSummaryService {
  constructor({
    cartService = null,
    feeConfigService = null,
    cartRepository = null,
  } = {}) {
    this.cartRepository = cartRepository ?? new CartRepository()
    this.cartService = cartService ?? new CartService(this.cartRepository)
    this.feeConfigService = feeConfigService ?? new FeeConfigService(new FeeConfigRepository())
  }

  /**
   * Compute complete bill summary for a user's cart
   */
  async getBillSummary(userId) {
    const cart = await this.cartService.getCart(userId)
    if (cart.items.length === 0) {
      return this._emptyBill()
    }

    const itemTotalOriginal = cart.items.reduce(
      (sum, item) => sum + (this._toNumber(item.price) * item.quantity), 0
    )
    const itemTotalDiscounted = cart.items.reduce(
      (sum, item) => sum + (this._toNumber(item.salePrice ?? item.price) * item.quantity), 0
    )
    const mrpDiscount = this._round(itemTotalOriginal - itemTotalDiscounted)

    const [
      deliveryConfig,
      handlingConfig,
      lateNightConfig,
      deliveryFee,
      tipAmount,
      deliveryEstimateMinutes,
    ] = await Promise.all([
      this._getFeeConfig('delivery_fee'),
      this._getFeeConfig('handling_fee'),
      this._getFeeConfig('late_night_fee'),
      this.feeConfigService.getDeliveryFee(itemTotalDiscounted),
      this.cartRepository.getTip(userId),
      this.feeConfigService.getDeliveryEstimate(),
    ])

    const deliveryBaseAmount = this._toNumber(deliveryConfig?.amount)
    const freeThreshold = deliveryConfig?.free_threshold === null || deliveryConfig?.free_threshold === undefined
      ? null
      : this._toNumber(deliveryConfig.free_threshold)
    const isDeliveryFree = deliveryFee === 0
    const freeDeliveryIn = isDeliveryFree || freeThreshold === null
      ? 0
      : this._round(Math.max(0, freeThreshold - itemTotalDiscounted))

    const handlingBaseAmount = this._toNumber(handlingConfig?.amount)
    const handlingFee = 0
    const handlingFeeSaved = this._round(Math.max(0, handlingBaseAmount - handlingFee))

    const lateNightBaseAmount = this._toNumber(lateNightConfig?.amount)
    const isLateNight = this.feeConfigService.isLateNight(lateNightConfig)
    const lateNightFee = 0
    const lateNightFeeSaved = this._round(Math.max(0, lateNightBaseAmount - lateNightFee))

    const toPayOriginal = this._round(
      itemTotalOriginal + deliveryBaseAmount + handlingBaseAmount + lateNightBaseAmount
    )
    const toPayFinal = this._round(
      itemTotalDiscounted + deliveryFee + handlingFee + lateNightFee + tipAmount
    )

    const savingsItems = []
    if (mrpDiscount > 0) {
      savingsItems.push({ type: 'mrp_discount', label: 'Discount on MRP', amount: mrpDiscount })
    }
    if (handlingFeeSaved > 0) {
      savingsItems.push({ type: 'handling_waiver', label: 'Savings on Handling fee', amount: handlingFeeSaved })
    }
    if (lateNightFeeSaved > 0) {
      savingsItems.push({ type: 'late_night_waiver', label: 'Savings on Late Night fee', amount: lateNightFeeSaved })
    }

    const savingsTotal = this._round(savingsItems.reduce((sum, item) => sum + item.amount, 0))

    return {
      itemTotal: {
        original: this._round(itemTotalOriginal),
        discounted: this._round(itemTotalDiscounted),
      },
      deliveryFee: {
        amount: this._round(deliveryFee),
        isFree: isDeliveryFree,
        freeIn: freeDeliveryIn,
      },
      handlingFee: {
        amount: handlingFee,
        isFree: true,
        savedAmount: handlingFeeSaved,
      },
      lateNightFee: {
        amount: lateNightFee,
        isFree: true,
        savedAmount: lateNightFeeSaved,
        isLateNight,
      },
      couponDiscount: 0, // Handled separately by coupon system
      tipAmount: this._round(tipAmount),
      toPay: {
        original: toPayOriginal,
        final: toPayFinal,
      },
      savings: {
        total: savingsTotal,
        breakdown: savingsItems,
      },
      deliveryEstimate: {
        minutes: deliveryEstimateMinutes,
        label: `Delivering in ${deliveryEstimateMinutes} mins`,
      },
      itemCount: cart.count,
    }
  }

  _emptyBill() {
    return {
      itemTotal: { original: 0, discounted: 0 },
      deliveryFee: { amount: 0, isFree: false, freeIn: 0 },
      handlingFee: { amount: 0, isFree: true, savedAmount: 0 },
      lateNightFee: { amount: 0, isFree: true, savedAmount: 0, isLateNight: false },
      couponDiscount: 0,
      tipAmount: 0,
      toPay: { original: 0, final: 0 },
      savings: { total: 0, breakdown: [] },
      deliveryEstimate: { minutes: 6, label: 'Delivering in 6 mins' },
      itemCount: 0,
    }
  }

  async _getFeeConfig(feeType) {
    return this.feeConfigService.repo.getByType(feeType)
  }

  _toNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  _round(value) {
    return parseFloat(this._toNumber(value).toFixed(2))
  }
}
