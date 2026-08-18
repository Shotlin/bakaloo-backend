import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

/**
 * Regression coverage for the reported gap: a FLAT_DISCOUNT cart milestone
 * ("Instant Discount" in the dashboard) was computed correctly at actual
 * order placement (orders.service.js) but never fed into getBillSummary()
 * — the screen the customer looks at while shopping — so the promised
 * "instant" discount was invisible until the order confirmation, instead
 * of reducing the total the moment the cart crossed the milestone.
 * Mirrors bill-summary.milestone-free-delivery.test.js's harness.
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

function cart({ subtotal = 100, shopGroups } = {}) {
  return {
    items: [{ productId: 'p-1', quantity: 1 }],
    subtotal,
    totalMrp: subtotal,
    tipAmount: 0,
    count: 1,
    shopGroups: shopGroups ?? [{ shopId: 'shop-1', subtotal, shopName: 'Test Shop', items: [] }],
  }
}

function buildService({ cartData, cartMilestonesService, firstTimeOffersService }) {
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
    firstTimeOffersService: firstTimeOffersService ?? {
      resolveForCheckout: vi.fn().mockResolvedValue(null),
      computeReward: vi.fn(),
    },
  })
}

describe('BillSummaryService — cart milestone instant discount (reported gap: promised discount only showed up after order placement)', () => {
  it('reduces toPay.final and adds a savings breakdown line the moment the cart unlocks a FLAT_DISCOUNT milestone', async () => {
    const milestone = { id: 'm-1', name: '₹49 flat off', rewardType: 'FLAT_DISCOUNT', rewardValue: 20, minCartAmount: 49 }
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: { ...milestone, message: 'unlocked' }, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([milestone]),
      computeReward: vi.fn().mockReturnValue({ discount: 20, freeDelivery: false }),
    }
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(result.couponDiscount).toBe(20)
    expect(result.toPay.final).toBe(100 - 20 + 30) // subtotal - discount + delivery fee
    expect(result.totalPayable).toBe(result.toPay.final)
    expect(result.savings.breakdown).toContainEqual({ type: 'cart_milestone', label: '₹49 flat off', amount: 20 })
    expect(result.savings.total).toBeGreaterThanOrEqual(20)
  })

  it('reduces the total by the correct percentage-mode amount, capped at maxDiscount', async () => {
    // 80% of 100 = 80, capped at 15 — proves the percent+cap math already
    // unit-tested in cart-milestones.service.test.js is actually wired
    // through to the customer-facing total, not just computed in isolation.
    const milestone = { id: 'm-2', name: '80% off, up to ₹15', rewardType: 'FLAT_DISCOUNT', rewardPercent: 80, maxDiscount: 15, minCartAmount: 49 }
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: { ...milestone, message: 'unlocked' }, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([milestone]),
      computeReward: vi.fn().mockReturnValue({ discount: 15, freeDelivery: false }),
    }
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(result.couponDiscount).toBe(15)
    expect(result.toPay.final).toBe(100 - 15 + 30)
  })

  it('does not apply the discount on a multi-shop cart — matches what order placement will actually charge (order-splitter only discounts one shop)', async () => {
    const milestone = { id: 'm-1', name: '₹49 flat off', rewardType: 'FLAT_DISCOUNT', rewardValue: 20, minCartAmount: 49 }
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: { ...milestone, message: 'unlocked' }, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([milestone]),
      computeReward: vi.fn().mockReturnValue({ discount: 20, freeDelivery: false }),
    }
    const multiShopCart = cart({
      subtotal: 100,
      shopGroups: [
        { shopId: 'shop-1', subtotal: 50, shopName: 'Shop A', items: [] },
        { shopId: 'shop-2', subtotal: 50, shopName: 'Shop B', items: [] },
      ],
    })
    const svc = buildService({ cartData: multiShopCart, cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(result.couponDiscount).toBe(0)
    expect(result.savings.breakdown.find((b) => b.type === 'cart_milestone')).toBeUndefined()
  })

  it('does not stack with an already-applied first-time-offer discount — single discount slot, same rule as OrdersService.placeOrder()', async () => {
    const milestone = { id: 'm-1', name: '₹49 flat off', rewardType: 'FLAT_DISCOUNT', rewardValue: 20, minCartAmount: 49 }
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: { ...milestone, message: 'unlocked' }, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([milestone]),
      computeReward: vi.fn().mockReturnValue({ discount: 20, freeDelivery: false }),
    }
    const firstTimeOffersService = {
      resolveForCheckout: vi.fn().mockResolvedValue({ id: 'fto-1', name: 'Welcome offer', autoApply: true, rewardType: 'FLAT_DISCOUNT' }),
      computeReward: vi.fn().mockReturnValue({ discount: 10, freeDelivery: false }),
    }
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService, firstTimeOffersService })

    const result = await svc.getBillSummary('user-1')

    // Only the first-time-offer's ₹10 applies — the milestone's ₹20 is
    // skipped rather than stacking (matches placeOrder()'s discountSlotTaken rule).
    expect(result.couponDiscount).toBe(10)
    expect(result.savings.breakdown.find((b) => b.type === 'cart_milestone')).toBeUndefined()
  })

  it('a CASHBACK milestone is unaffected — cashback never touches the discount slot (unaffected default case)', async () => {
    const milestone = { id: 'm-1', name: 'Cashback tier', rewardType: 'CASHBACK', rewardValue: 20, minCartAmount: 49 }
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: { ...milestone, message: 'unlocked' }, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([milestone]),
      computeReward: vi.fn().mockReturnValue({ cashbackAmount: 20, freeDelivery: false }),
    }
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(result.couponDiscount).toBe(0)
    expect(result.toPay.final).toBe(100 + 30)
  })
})
