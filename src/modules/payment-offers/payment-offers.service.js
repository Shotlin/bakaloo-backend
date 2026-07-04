import { PaymentOffersRepository } from './payment-offers.repository.js'

/**
 * Payment offers service — public formatting + admin CRUD orchestration
 */
export class PaymentOffersService {
  constructor(repository = new PaymentOffersRepository()) {
    this.repo = repository
  }

  async getPublicOffers(cartTotal) {
    const normalizedCartTotal = Math.max(0, this._toNumber(cartTotal))
    const offers = await this.repo.getActive()

    return offers
      .map((offer) => {
        const minOrderAmount = this._toNumber(offer.min_order_amount)
        const lockThreshold = this._toNumber(
          offer.lock_threshold ?? offer.min_order_amount
        )
        const requiredThreshold = lockThreshold || minOrderAmount
        const isLocked = normalizedCartTotal < requiredThreshold
        const amountNeeded = isLocked
          ? Math.ceil(Math.max(0, requiredThreshold - normalizedCartTotal))
          : 0

        return {
          id: offer.id,
          title: offer.title,
          description: offer.description,
          provider: offer.provider,
          iconUrl: offer.icon_url,
          cashbackAmount: this._toNumber(offer.cashback_amount),
          minOrderAmount,
          isLocked,
          lockMessage: isLocked
            ? `Shop for ₹${amountNeeded} more to apply`
            : null,
          unlockProgress: Math.min(
            normalizedCartTotal / (requiredThreshold || 1),
            1
          ),
        }
      })
      .sort((left, right) => {
        if (left.isLocked != right.isLocked) {
          return Number(left.isLocked) - Number(right.isLocked)
        }
        return right.cashbackAmount - left.cashbackAmount
      })
  }

  async getAllAdmin() {
    return this.repo.getAll()
  }

  async create(data) {
    return this.repo.create(this._mapWriteData(data))
  }

  async update(id, data) {
    const existing = await this.repo.getById(id)
    if (!existing) {
      const error = new Error('Payment offer not found')
      error.statusCode = 404
      error.code = 'NOT_FOUND'
      throw error
    }

    const nextData = {
      title: this._hasOwn(data, 'title') ? data.title : existing.title,
      description: this._hasOwn(data, 'description') ? data.description : existing.description,
      provider: this._hasOwn(data, 'provider') ? data.provider : existing.provider,
      iconUrl: this._hasOwn(data, 'iconUrl') ? data.iconUrl : existing.icon_url,
      cashbackAmount: this._hasOwn(data, 'cashbackAmount') ? data.cashbackAmount : existing.cashback_amount,
      cashbackPercent: this._hasOwn(data, 'cashbackPercent') ? data.cashbackPercent : existing.cashback_percent,
      minOrderAmount: this._hasOwn(data, 'minOrderAmount') ? data.minOrderAmount : existing.min_order_amount,
      maxCashback: this._hasOwn(data, 'maxCashback') ? data.maxCashback : existing.max_cashback,
      lockThreshold: this._hasOwn(data, 'lockThreshold') ? data.lockThreshold : existing.lock_threshold,
      isActive: this._hasOwn(data, 'isActive') ? data.isActive : existing.is_active,
      validFrom: this._hasOwn(data, 'validFrom') ? data.validFrom : existing.valid_from,
      validUntil: this._hasOwn(data, 'validUntil') ? data.validUntil : existing.valid_until,
      cashbackCreditTrigger: this._hasOwn(data, 'cashbackCreditTrigger') ? data.cashbackCreditTrigger : existing.cashback_credit_trigger,
      usageLimitPerUser: this._hasOwn(data, 'usageLimitPerUser') ? data.usageLimitPerUser : existing.usage_limit_per_user,
    }

    return this.repo.update(id, this._mapWriteData(nextData))
  }

  /**
   * Best-fit active payment offer for this cart/user at checkout, or null.
   * "Best fit" = highest resulting cashback among every offer whose
   * min_order_amount is met and whose per-user usage cap (if any) hasn't
   * been hit yet. This is the piece that was entirely missing before —
   * getPublicOffers() only ever computed a display lock/unlock flag, never
   * an amount to actually credit.
   */
  async resolveForCheckout(userId, cartTotal) {
    const normalizedCartTotal = Math.max(0, this._toNumber(cartTotal))
    const offers = await this.repo.getActive()

    let best = null
    for (const offer of offers) {
      if (normalizedCartTotal < this._toNumber(offer.min_order_amount)) continue

      if (offer.usage_limit_per_user != null) {
        const usage = await this.repo.getUserUsageCount(offer.id, userId)
        if (usage >= offer.usage_limit_per_user) continue
      }

      const amount = this._computeCashback(offer, normalizedCartTotal)
      if (amount > 0 && (!best || amount > best.amount)) {
        best = { offer, amount }
      }
    }

    if (!best) return null
    return {
      offerId: best.offer.id,
      cashbackAmount: best.amount,
      creditTrigger: best.offer.cashback_credit_trigger || 'ORDER_DELIVERED',
    }
  }

  /** Record that a user has redeemed an offer for a specific order. */
  async recordUsage(offerId, userId, orderId) {
    return this.repo.recordUsage(offerId, userId, orderId)
  }

  /** @private */
  _computeCashback(offer, cartTotal) {
    let amount = this._toNumber(offer.cashback_amount)
    if (offer.cashback_percent) {
      amount = cartTotal * (this._toNumber(offer.cashback_percent) / 100)
    }
    if (offer.max_cashback) {
      amount = Math.min(amount, this._toNumber(offer.max_cashback))
    }
    return Math.round(amount * 100) / 100
  }

  async delete(id) {
    const deleted = await this.repo.delete(id)
    if (!deleted) {
      const error = new Error('Payment offer not found')
      error.statusCode = 404
      error.code = 'NOT_FOUND'
      throw error
    }
  }

  _mapWriteData(data) {
    return {
      title: data.title,
      description: data.description ?? null,
      provider: data.provider,
      icon_url: data.iconUrl ?? null,
      cashback_amount: data.cashbackAmount ?? 0,
      cashback_percent: data.cashbackPercent ?? null,
      min_order_amount: data.minOrderAmount ?? 0,
      max_cashback: data.maxCashback ?? null,
      lock_threshold: data.lockThreshold ?? null,
      is_active: data.isActive ?? true,
      valid_from: data.validFrom ?? null,
      valid_until: data.validUntil ?? null,
      cashback_credit_trigger: data.cashbackCreditTrigger ?? 'ORDER_DELIVERED',
      usage_limit_per_user: data.usageLimitPerUser ?? null,
    }
  }

  _hasOwn(data, key) {
    return Object.prototype.hasOwnProperty.call(data, key)
  }

  _toNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
}
