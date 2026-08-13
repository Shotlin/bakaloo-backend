import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

/**
 * Regression coverage for the reported bug: a cart milestone with
 * grants_free_delivery=true (e.g. "min cart ₹50 → free delivery") never
 * actually waived the delivery fee shown while shopping. getBillSummary()
 * (what GET /api/v1/cart/summary — the screen the customer looks at —
 * returns) resolved the milestone's progress purely for the "Add ₹X more"
 * ladder text and never fed its reward into forceFreeDelivery, so the
 * delivery fee line stayed unwaived right up until order placement (and
 * even there a separate discount-slot bug could drop it too — see
 * orders.service.js coverage). This suite exercises the real
 * getBillSummary() end-to-end, mirroring bill-summary.first-time-offer.test.js.
 */

const flatConfig = {
  delivery_fee_enabled: true,
  handling_fee_enabled: false,
  platform_fee_enabled: false,
  small_cart_fee_enabled: false,
  surge_fee_enabled: false,
  packaging_fee_enabled: false,
  quick_delivery_surcharge_enabled: false,
  gst_enabled: false,
  free_delivery_enabled: false,
  min_delivery_fee: 30,
  base_distance_km: 0,
  per_km_fee: 0,
}

function cart({ subtotal = 100 } = {}) {
  return {
    items: [{ productId: 'p-1', quantity: 1 }],
    subtotal,
    totalMrp: subtotal,
    tipAmount: 0,
    count: 1,
    shopGroups: [{ shopId: 'shop-1', subtotal, shopName: 'Test Shop' }],
  }
}

function buildService({ cartData, cartMilestonesService }) {
  return new BillSummaryService({
    cartService: { getCart: vi.fn().mockResolvedValue(cartData) },
    feeSettingsService: {
      resolveForShop: vi.fn().mockResolvedValue({ config: flatConfig, source: 'default' }),
    },
    paymentSettingsService: {
      getConfig: vi.fn().mockResolvedValue({
        codEnabled: true,
        codMinOrderAmount: 0,
        codMaxOrderAmount: null,
        razorpayEnabled: true,
        walletEnabled: true,
      }),
    },
    cartMilestonesService,
    firstTimeOffersService: {
      resolveForCheckout: vi.fn().mockResolvedValue(null),
      computeReward: vi.fn(),
    },
  })
}

describe('BillSummaryService — cart milestone free delivery (reported bug: min ₹50 → free delivery never waived the shown fee)', () => {
  it('waives the delivery fee once the cart unlocks a milestone that grants free delivery', async () => {
    const milestone = { id: 'm-1', name: 'Free delivery tier', rewardType: 'CASHBACK', rewardValue: 10, grantsFreeDelivery: true, minCartAmount: 50 }
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: { ...milestone, message: 'unlocked' }, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([milestone]),
      computeReward: vi.fn().mockReturnValue({ cashbackAmount: 10, freeDelivery: true }),
    }
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(cartMilestonesService.computeReward).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-1' }), 100)
    expect(result.deliveryFee.isFree).toBe(true)
    expect(result.deliveryFee.amount).toBe(0)
    expect(result.freeDelivery.unlocked).toBe(true)
  })

  it('still charges delivery when no milestone is unlocked yet (unaffected default case)', async () => {
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: null, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([]),
      computeReward: vi.fn(),
    }
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(cartMilestonesService.computeReward).not.toHaveBeenCalled()
    expect(result.deliveryFee.isFree).toBe(false)
    expect(result.deliveryFee.amount).toBe(30)
  })

  it('does not waive delivery when the unlocked milestone does not grant it', async () => {
    const milestone = { id: 'm-2', name: 'Cashback only tier', rewardType: 'CASHBACK', rewardValue: 10, grantsFreeDelivery: false, minCartAmount: 50 }
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: { ...milestone, message: 'unlocked' }, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([milestone]),
      computeReward: vi.fn().mockReturnValue({ cashbackAmount: 10, freeDelivery: false }),
    }
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(result.deliveryFee.isFree).toBe(false)
  })

  it('a milestone lookup failure never breaks the cart summary (best-effort)', async () => {
    const cartMilestonesService = {
      getProgress: vi.fn().mockRejectedValue(new Error('db down')),
      getEligibleTiers: vi.fn().mockRejectedValue(new Error('db down')),
      computeReward: vi.fn(),
    }
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(result.deliveryFee.isFree).toBe(false)
    expect(result.cartMilestone).toEqual({ unlocked: null, next: null, ladder: [] })
  })
})
