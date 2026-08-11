import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

// Performance regression coverage: GET /cart/summary is refetched by the
// Flutter app on every Cart -> Checkout screen transition (its bill-summary
// provider is torn down and rebuilt on that route change), so its latency
// directly controls how long the checkout screen briefly falls back to an
// incomplete local total estimate. getBillSummary() used to resolve a
// single-shop cart's fee config TWICE — once for the aggregate breakdown,
// then again for that exact same shop inside the per-shop loop — a fully
// redundant DB round trip for the most common cart shape (one shop). This
// suite proves that duplicate call is gone, and that reusing the
// already-resolved config still produces the correct fee amounts.

const flatConfig = {
  delivery_fee_enabled: false,
  handling_fee_enabled: true,
  handling_fee_type: 'FLAT',
  handling_fee_value: 5,
  platform_fee_enabled: false,
  small_cart_fee_enabled: false,
  surge_fee_enabled: false,
  packaging_fee_enabled: false,
  quick_delivery_surcharge_enabled: false,
  gst_enabled: false,
  free_delivery_enabled: false,
}

function buildService({ cartData, resolveForShop }) {
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
    cartMilestonesService: {
      getProgress: vi.fn().mockResolvedValue({ unlocked: null, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([]),
    },
    firstTimeOffersService: {
      resolveForCheckout: vi.fn().mockResolvedValue(null),
      previewUpcoming: vi.fn().mockResolvedValue(null),
    },
  })
}

describe('BillSummaryService — fee config lookup is not duplicated per request', () => {
  it('resolves a single-shop cart\'s fee config exactly once (was twice)', async () => {
    const resolveForShop = vi.fn().mockResolvedValue({ config: flatConfig, source: 'default' })
    const cartData = {
      items: [{ productId: 'p-1', quantity: 1 }],
      subtotal: 26,
      totalMrp: 26,
      tipAmount: 0,
      count: 1,
      shopGroups: [{ shopId: 'shop-1', subtotal: 26, shopName: 'Test Shop' }],
    }
    const svc = buildService({ cartData, resolveForShop })

    const result = await svc.getBillSummary('user-1')

    expect(resolveForShop).toHaveBeenCalledTimes(1)
    expect(resolveForShop).toHaveBeenCalledWith('shop-1')
    // The reused config must still actually apply — not silently dropped —
    // so the handling fee configured above must show up in the total.
    expect(result.handlingFee.amount).toBe(5)
    expect(result.totalPayable).toBe(31)
  })

  it('resolves each shop exactly once for a multi-shop cart (aggregate + one per shop, still no duplicates)', async () => {
    const resolveForShop = vi.fn().mockResolvedValue({ config: flatConfig, source: 'default' })
    const cartData = {
      items: [
        { productId: 'p-1', quantity: 1 },
        { productId: 'p-2', quantity: 1 },
      ],
      subtotal: 50,
      totalMrp: 50,
      tipAmount: 0,
      count: 2,
      shopGroups: [
        { shopId: 'shop-1', subtotal: 26, shopName: 'Shop One' },
        { shopId: 'shop-2', subtotal: 24, shopName: 'Shop Two' },
      ],
    }
    const svc = buildService({ cartData, resolveForShop })

    await svc.getBillSummary('user-1')

    // One resolution for the aggregate (global, since >1 shop) plus one per
    // shop in the loop — three total, none of them a repeat of the same shop.
    expect(resolveForShop).toHaveBeenCalledTimes(3)
    expect(resolveForShop).toHaveBeenCalledWith(null)
    expect(resolveForShop).toHaveBeenCalledWith('shop-1')
    expect(resolveForShop).toHaveBeenCalledWith('shop-2')
  })
})
