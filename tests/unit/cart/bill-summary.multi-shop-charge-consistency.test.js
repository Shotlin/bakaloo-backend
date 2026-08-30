import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

/**
 * Regression coverage for a class of "cart preview shows one total, checkout
 * charges another" bugs that only surface on MULTI-shop carts (a customer
 * whose items span more than one nearby store).
 *
 * Root cause: order-splitter.service.js's fee-waiver mechanisms
 * (feeContext.freeDeliveryShopId / tipShopId / quickDeliveryShopId) can only
 * ever target ONE shop's split order per checkout, and orders.service.js's
 * placeOrder() explicitly, deliberately gates cart-milestone free delivery,
 * tip, and the Quick Delivery surcharge behind `groupedByShop.size === 1`
 * for exactly that reason (see orders.service.js's own comments). This
 * bill-summary.service.js preview did not mirror those same restrictions in
 * several places, so it promised a total on a multi-shop cart that checkout
 * would not actually honor:
 *   - a cart milestone's FREE_DELIVERY reward force-waived every shop's
 *     delivery fee in the preview, but checkout would still charge full
 *     delivery on every shop (freeDeliveryOverride never gets set for a
 *     multi-shop cart in orders.service.js).
 *   - a customer's tip / a selected Quick Delivery surcharge were folded
 *     into totalPayable/toPay.final unconditionally, but checkout drops
 *     both entirely for a multi-shop cart (tipShopId/quickDeliveryShopId
 *     are null there, so no shop's order ever gets charged for them).
 *   - the multi-shop GST recomputation applied one blanket gst_rate (the
 *     GLOBAL config) to the combined pre-tax total, rather than each shop's
 *     own resolved config — divergent from the real per-shop-computed
 *     charge whenever a shop has a distinct STORE-level GST override.
 *   - totalSavings/"you saved" used the single (non-summed) delivery
 *     "original fee" from one internal computeBreakdown call instead of the
 *     correctly-summed multi-shop deliveryFeeOriginal, understating the
 *     real saved amount whenever delivery was waived on a multi-shop cart.
 */

const baseConfig = {
  delivery_fee_enabled: true,
  min_delivery_fee: 30,
  base_distance_km: 0,
  per_km_fee: 0,
  max_delivery_distance_km: null,
  free_delivery_enabled: false,
  free_delivery_above: null,
  handling_fee_enabled: false,
  platform_fee_enabled: false,
  small_cart_fee_enabled: false,
  surge_fee_enabled: false,
  packaging_fee_enabled: false,
  quick_delivery_surcharge_enabled: false,
  quick_delivery_surcharge_amount: 0,
  gst_enabled: false,
  gst_rate: 0,
}

function twoShopCart({ tipAmount = 0 } = {}) {
  return {
    items: [
      { productId: 'p-1', quantity: 1 },
      { productId: 'p-2', quantity: 1 },
    ],
    subtotal: 300,
    totalMrp: 300,
    tipAmount,
    count: 2,
    shopGroups: [
      { shopId: 'shop-1', subtotal: 200, shopName: 'Shop One', items: [] },
      { shopId: 'shop-2', subtotal: 100, shopName: 'Shop Two', items: [] },
    ],
  }
}

function buildService({ cartData, resolveForShop, cartMilestonesService }) {
  return new BillSummaryService({
    cartService: { getCart: vi.fn().mockResolvedValue(cartData) },
    feeSettingsService: { resolveForShop },
    paymentSettingsService: {
      getConfig: vi.fn().mockResolvedValue({
        codEnabled: true,
        codMinOrderAmount: 0,
        codMaxOrderAmount: null,
        razorpayEnabled: true,
        walletEnabled: true,
      }),
    },
    cartMilestonesService: cartMilestonesService ?? {
      getProgress: vi.fn().mockResolvedValue({ unlocked: null, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([]),
    },
    firstTimeOffersService: {
      resolveForCheckout: vi.fn().mockResolvedValue(null),
      previewUpcoming: vi.fn().mockResolvedValue(null),
      computeReward: vi.fn(),
    },
  })
}

describe('BillSummaryService — multi-shop preview never promises more than checkout will charge', () => {
  it('does NOT waive delivery on every shop when a cart milestone grants free delivery (checkout only ever honors this on a single-shop cart)', async () => {
    const resolveForShop = vi.fn().mockResolvedValue({ config: baseConfig, source: 'default' })
    const milestone = { id: 'm-1', name: 'Free delivery tier', rewardType: 'CASHBACK', grantsFreeDelivery: true, minCartAmount: 50 }
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: { ...milestone, message: 'unlocked' }, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([milestone]),
      computeReward: vi.fn().mockReturnValue({ cashbackAmount: 0, freeDelivery: true }),
    }
    const svc = buildService({ cartData: twoShopCart(), resolveForShop, cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    // Both shops must still be charged their real ₹30 delivery fee — a
    // multi-shop milestone free-delivery reward cannot actually be honored
    // by checkout, so the preview must not claim otherwise.
    expect(result.deliveryFee.amount).toBe(60)
    expect(result.deliveryFee.isFree).toBe(false)
    expect(result.freeDelivery.unlocked).toBe(false)
    expect(result.totalPayable).toBe(360) // 300 subtotal + 60 real delivery
  })

  it('still waives delivery on every shop via the milestone when the cart IS single-shop (unaffected case)', async () => {
    const resolveForShop = vi.fn().mockResolvedValue({ config: baseConfig, source: 'default' })
    const milestone = { id: 'm-1', name: 'Free delivery tier', rewardType: 'CASHBACK', grantsFreeDelivery: true, minCartAmount: 50 }
    const cartMilestonesService = {
      getProgress: vi.fn().mockResolvedValue({ unlocked: { ...milestone, message: 'unlocked' }, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([milestone]),
      computeReward: vi.fn().mockReturnValue({ cashbackAmount: 0, freeDelivery: true }),
    }
    const singleShopCart = {
      items: [{ productId: 'p-1', quantity: 1 }],
      subtotal: 100,
      totalMrp: 100,
      tipAmount: 0,
      count: 1,
      shopGroups: [{ shopId: 'shop-1', subtotal: 100, shopName: 'Shop One', items: [] }],
    }
    const svc = buildService({ cartData: singleShopCart, resolveForShop, cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(result.deliveryFee.amount).toBe(0)
    expect(result.deliveryFee.isFree).toBe(true)
  })

  it('sums the real per-shop delivery-original into totalSavings when threshold-based free delivery waives multiple shops', async () => {
    const resolveForShop = vi.fn().mockResolvedValue({
      config: { ...baseConfig, free_delivery_enabled: true, free_delivery_above: 50 },
      source: 'default',
    })
    const svc = buildService({ cartData: twoShopCart(), resolveForShop })

    const result = await svc.getBillSummary('user-1')

    // Both shops (subtotal 200 and 100) clear the ₹50 threshold in
    // isolation, so both get their ₹30 delivery fee waived — the real
    // total saved is 30+30=60, not a single shop's ₹30.
    expect(result.deliveryFee.amount).toBe(0)
    expect(result.deliveryFee.isFree).toBe(true)
    expect(result.savings.total).toBe(60)
    expect(result.totals.totalSavings).toBe(60)
  })

  it('drops the tip from totalPayable/tipAmount on a multi-shop cart (checkout never charges it — tipShopId is null there)', async () => {
    const resolveForShop = vi.fn().mockResolvedValue({
      config: { ...baseConfig, delivery_fee_enabled: false },
      source: 'default',
    })
    const svc = buildService({ cartData: twoShopCart({ tipAmount: 20 }), resolveForShop })

    const result = await svc.getBillSummary('user-1')

    expect(result.tipAmount).toBe(0)
    expect(result.toPay.final).toBe(300)
    expect(result.totalPayable).toBe(300)
  })

  it('keeps the tip on a single-shop cart (unaffected case)', async () => {
    const resolveForShop = vi.fn().mockResolvedValue({
      config: { ...baseConfig, delivery_fee_enabled: false },
      source: 'default',
    })
    const singleShopCart = {
      items: [{ productId: 'p-1', quantity: 1 }],
      subtotal: 100,
      totalMrp: 100,
      tipAmount: 20,
      count: 1,
      shopGroups: [{ shopId: 'shop-1', subtotal: 100, shopName: 'Shop One', items: [] }],
    }
    const svc = buildService({ cartData: singleShopCart, resolveForShop })

    const result = await svc.getBillSummary('user-1')

    expect(result.tipAmount).toBe(20)
    expect(result.toPay.final).toBe(120)
  })

  it('drops the Quick Delivery surcharge on a multi-shop cart even when selected (checkout never charges it — quickDeliveryShopId is null there)', async () => {
    const resolveForShop = vi.fn().mockResolvedValue({
      config: { ...baseConfig, delivery_fee_enabled: false, quick_delivery_surcharge_enabled: true, quick_delivery_surcharge_amount: 15 },
      source: 'default',
    })
    const svc = buildService({ cartData: twoShopCart(), resolveForShop })

    const result = await svc.getBillSummary('user-1', null, { quickDeliverySelected: true })

    expect(result.totalPayable).toBe(300)
    expect(result.fees.find((f) => f.code === 'QUICK_DELIVERY_SURCHARGE')).toBeUndefined()
  })

  it('sums each shop\'s own GST config instead of applying one blanket rate on a multi-shop cart', async () => {
    const configByShop = {
      'shop-1': { ...baseConfig, delivery_fee_enabled: false, gst_enabled: true, gst_rate: 5 },
      'shop-2': { ...baseConfig, delivery_fee_enabled: false, gst_enabled: false, gst_rate: 0 },
    }
    // The aggregate (shopId=null) resolution — mirrors GLOBAL config, which
    // must NOT be what actually drives the multi-shop GST math.
    const globalConfig = { ...baseConfig, delivery_fee_enabled: false, gst_enabled: true, gst_rate: 18 }
    const resolveForShop = vi.fn().mockImplementation(async (shopId) => ({
      config: shopId ? configByShop[shopId] : globalConfig,
      source: shopId ? 'STORE' : 'GLOBAL',
    }))
    const svc = buildService({ cartData: twoShopCart(), resolveForShop })

    const result = await svc.getBillSummary('user-1')

    // Real charge: shop-1 = 5% of 200 = 10, shop-2 = 0% of 100 = 0 → 10 total.
    // The old blanket-GLOBAL-rate bug would have applied 18% to the
    // combined 300 subtotal = 54, wildly overcharging the preview.
    expect(result.totals.tax).toBe(10)
    expect(result.totalPayable).toBe(310)
  })
})
