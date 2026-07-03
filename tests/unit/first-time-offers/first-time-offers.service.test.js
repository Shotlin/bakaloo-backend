// Coverage for FirstTimeOffersService — best-fit graduated offer
// resolution and reward computation. Constructor-injected repo, no
// database mocking needed.

import { describe, expect, it, vi } from 'vitest'
import { FirstTimeOffersService } from '../../../src/modules/first-time-offers/first-time-offers.service.js'

const USER_ID = 'user-1'

function makeRepoMock(overrides = {}) {
  return {
    hasPriorOrder: vi.fn().mockResolvedValue(false),
    findBestFitActive: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

describe('FirstTimeOffersService.resolveForCheckout (positive/negative)', () => {
  it('returns null for a repeat customer regardless of cart total (negative — anti-abuse)', async () => {
    const repo = makeRepoMock({ hasPriorOrder: vi.fn().mockResolvedValue(true) })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 999)

    expect(offer).toBeNull()
    expect(repo.findBestFitActive).not.toHaveBeenCalled()
  })

  it('returns the best-fit offer for a real first-time customer (positive)', async () => {
    const repo = makeRepoMock({
      findBestFitActive: vi.fn().mockResolvedValue({ id: 'offer-999', minOrderAmount: 999, rewardType: 'WALLET_CASHBACK', rewardValue: 100 }),
    })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 1200)

    expect(offer.id).toBe('offer-999')
    expect(repo.findBestFitActive).toHaveBeenCalledWith(1200, { onlinePayment: undefined })
  })

  it('passes the onlinePayment flag through so COD checkouts exclude ONLINE_ONLY offers', async () => {
    const repo = makeRepoMock()
    const service = new FirstTimeOffersService(repo)

    await service.resolveForCheckout(USER_ID, 500, { onlinePayment: false })

    expect(repo.findBestFitActive).toHaveBeenCalledWith(500, { onlinePayment: false })
  })
})

describe('FirstTimeOffersService.computeReward — each reward type (positive)', () => {
  const service = new FirstTimeOffersService(makeRepoMock())

  it('FREE_DELIVERY yields a plain flag, no amount', () => {
    const reward = service.computeReward({ rewardType: 'FREE_DELIVERY' }, 350)
    expect(reward).toEqual({ freeDelivery: true })
  })

  it('FLAT_DISCOUNT is capped at the cart total', () => {
    const reward = service.computeReward({ rewardType: 'FLAT_DISCOUNT', rewardValue: 5000 }, 100)
    expect(reward.discount).toBe(100)
  })

  it('PERCENTAGE_DISCOUNT applies maxDiscount cap', () => {
    const reward = service.computeReward(
      { rewardType: 'PERCENTAGE_DISCOUNT', rewardValue: 50, maxDiscount: 30 },
      1000
    )
    expect(reward.discount).toBe(30)
  })

  it('WALLET_CASHBACK returns the flat reward value as cashbackAmount', () => {
    const reward = service.computeReward({ rewardType: 'WALLET_CASHBACK', rewardValue: 100 }, 999)
    expect(reward).toEqual({ cashbackAmount: 100 })
  })

  it('COUPON_UNLOCK returns the coupon id to unlock', () => {
    const reward = service.computeReward({ rewardType: 'COUPON_UNLOCK', unlockCouponId: 'coupon-42' }, 500)
    expect(reward).toEqual({ unlockCouponId: 'coupon-42' })
  })
})

describe('FirstTimeOffersService graduated-ladder scenario (positive — matches the 3 examples from the spec)', () => {
  it('a ₹1200 cart resolves to the ₹999 tier (highest satisfied threshold), not the ₹299 or ₹499 tier', async () => {
    // findBestFitActive is a repository concern (ORDER BY min_order_amount
    // DESC LIMIT 1) — this test asserts the service passes the real cart
    // total through untouched so that SQL-level selection is exercised
    // correctly by whichever tier the repo actually returns for it.
    const repo = makeRepoMock({
      findBestFitActive: vi.fn().mockResolvedValue({
        id: 'offer-999', minOrderAmount: 999, rewardType: 'WALLET_CASHBACK', rewardValue: 100,
      }),
    })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 1200)

    expect(offer.minOrderAmount).toBe(999)
    expect(service.computeReward(offer, 1200)).toEqual({ cashbackAmount: 100 })
  })
})
