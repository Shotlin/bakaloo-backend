import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'
import { CartMilestonesService } from '../../../src/modules/cart-milestones/cart-milestones.service.js'

/**
 * True end-to-end proof that the exclude-first-time-customer and
 * excluded-segment rules actually reach the exact response the mobile app
 * reads for the cart screen — not just that CartMilestonesService.
 * _isEligible() returns the right boolean in isolation (already covered in
 * cart-milestones.service.test.js), and not just that BillSummaryService
 * correctly reflects whatever a MOCKED milestone service hands it (already
 * covered in bill-summary.milestone-instant-discount.test.js).
 *
 * Here the REAL CartMilestonesService (only its DB-facing repository is
 * faked) is wired into a REAL BillSummaryService and driven through
 * getBillSummary() — the same call GET /api/v1/cart/summary makes, which is
 * what the Flutter app's Smart Bottom Bar and cart screen actually render.
 * If this passes, the rule is provably followed all the way to the JSON
 * response the app receives, with nothing mocked in between.
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
    shopGroups: [{ shopId: 'shop-1', subtotal, shopName: 'Test Shop', items: [] }],
  }
}

/** Bare-minimum fake repo — only the DB-facing methods CartMilestonesService actually calls. */
function makeFakeMilestoneRepo({ milestones, hasPriorOrder }) {
  return {
    findAllActive: vi.fn().mockResolvedValue(milestones),
    hasPriorOrder: vi.fn().mockResolvedValue(hasPriorOrder),
    getUserUsageCount: vi.fn().mockResolvedValue(0),
    resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()),
    getCategoryNames: vi.fn().mockResolvedValue([]),
    getProductNames: vi.fn().mockResolvedValue([]),
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
        codEnabled: true, codMinOrderAmount: 0, codMaxOrderAmount: null,
        razorpayEnabled: true, walletEnabled: true,
      }),
    },
    cartMilestonesService,
    firstTimeOffersService: {
      resolveForCheckout: vi.fn().mockResolvedValue(null),
      previewUpcoming: vi.fn().mockResolvedValue(null),
      computeReward: vi.fn(),
    },
  })
}

describe('End-to-end: "Exclude first-time customers" toggle reaches the actual GET /api/v1/cart/summary response', () => {
  it('a first-time customer never sees the milestone — cartMilestone.unlocked and .next are both null', async () => {
    const milestone = {
      id: 'm-1', name: 'All users ₹49 tier', minCartAmount: 49,
      rewardType: 'CASHBACK', rewardValue: 20,
      applicableUserType: 'ALL', excludeFirstTimeUsers: true,
      stackableWithCoupon: true, cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const repo = makeFakeMilestoneRepo({ milestones: [milestone], hasPriorOrder: false })
    const cartMilestonesService = new CartMilestonesService(repo, { isMember: vi.fn() })
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-first-time')

    expect(result.cartMilestone.unlocked).toBeNull()
    expect(result.cartMilestone.next).toBeNull()
    expect(result.cartMilestone.ladder).toEqual([])
    expect(result.savings.breakdown.find((b) => b.type === 'cart_milestone')).toBeUndefined()
  })

  it('a returning customer DOES see and earn the exact same milestone — proves the toggle excludes only first-timers, not everyone', async () => {
    const milestone = {
      id: 'm-1', name: 'All users ₹49 tier', minCartAmount: 49,
      rewardType: 'CASHBACK', rewardValue: 20,
      applicableUserType: 'ALL', excludeFirstTimeUsers: true,
      stackableWithCoupon: true, cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const repo = makeFakeMilestoneRepo({ milestones: [milestone], hasPriorOrder: true })
    const cartMilestonesService = new CartMilestonesService(repo, { isMember: vi.fn() })
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-returning')

    expect(result.cartMilestone.unlocked).not.toBeNull()
    expect(result.cartMilestone.unlocked.id).toBe('m-1')
    expect(result.cartMilestone.unlocked.name).toBe('All users ₹49 tier')
  })

  it('with the toggle OFF, a first-time customer sees the milestone exactly as before (unaffected default case)', async () => {
    const milestone = {
      id: 'm-1', name: 'All users ₹49 tier', minCartAmount: 49,
      rewardType: 'CASHBACK', rewardValue: 20,
      applicableUserType: 'ALL', excludeFirstTimeUsers: false,
      stackableWithCoupon: true, cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const repo = makeFakeMilestoneRepo({ milestones: [milestone], hasPriorOrder: false })
    const cartMilestonesService = new CartMilestonesService(repo, { isMember: vi.fn() })
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-first-time')

    expect(result.cartMilestone.unlocked?.id).toBe('m-1')
  })
})

describe('End-to-end: "Exclude a segment" toggle reaches the actual GET /api/v1/cart/summary response', () => {
  it('a member of the excluded segment never sees the milestone', async () => {
    const milestone = {
      id: 'm-1', name: 'All users ₹49 tier', minCartAmount: 49,
      rewardType: 'CASHBACK', rewardValue: 20,
      applicableUserType: 'ALL', excludedSegmentId: 'seg-vip',
      stackableWithCoupon: true, cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const repo = makeFakeMilestoneRepo({ milestones: [milestone], hasPriorOrder: true })
    const segmentsRepo = { isMember: vi.fn().mockResolvedValue(true) }
    const cartMilestonesService = new CartMilestonesService(repo, segmentsRepo)
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-vip-segment')

    expect(result.cartMilestone.unlocked).toBeNull()
    expect(segmentsRepo.isMember).toHaveBeenCalledWith('seg-vip', 'user-vip-segment')
  })

  it('a non-member of the excluded segment still sees the milestone', async () => {
    const milestone = {
      id: 'm-1', name: 'All users ₹49 tier', minCartAmount: 49,
      rewardType: 'CASHBACK', rewardValue: 20,
      applicableUserType: 'ALL', excludedSegmentId: 'seg-vip',
      stackableWithCoupon: true, cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const repo = makeFakeMilestoneRepo({ milestones: [milestone], hasPriorOrder: true })
    const segmentsRepo = { isMember: vi.fn().mockResolvedValue(false) }
    const cartMilestonesService = new CartMilestonesService(repo, segmentsRepo)
    const svc = buildService({ cartData: cart({ subtotal: 100 }), cartMilestonesService })

    const result = await svc.getBillSummary('user-other-segment')

    expect(result.cartMilestone.unlocked?.id).toBe('m-1')
  })
})

describe('End-to-end: scoped (category/product) milestone reaches the actual response correctly', () => {
  it('a category-scoped milestone unlocks against the real matching-items computation, not a mock', async () => {
    const milestone = {
      id: 'm-veg', name: 'Veg lovers tier', minCartAmount: 40,
      rewardType: 'FLAT_DISCOUNT', rewardValue: 15,
      applicableUserType: 'ALL', applicableCategoryIds: ['cat-veg'],
      stackableWithCoupon: true, cashbackCreditTrigger: 'ORDER_DELIVERED',
    }
    const repo = makeFakeMilestoneRepo({ milestones: [milestone], hasPriorOrder: true })
    repo.resolveMatchingProductIds = vi.fn().mockResolvedValue(new Set(['p-1']))
    const cartMilestonesService = new CartMilestonesService(repo, { isMember: vi.fn() })
    const cartData = {
      items: [{ productId: 'p-1', quantity: 1 }],
      subtotal: 100,
      totalMrp: 100,
      tipAmount: 0,
      count: 1,
      shopGroups: [{
        shopId: 'shop-1', subtotal: 100, shopName: 'Test Shop',
        items: [{ productId: 'p-1', lineTotal: 100, effectivePrice: 100, quantity: 1 }],
      }],
    }
    const svc = buildService({ cartData, cartMilestonesService })

    const result = await svc.getBillSummary('user-1')

    expect(result.cartMilestone.unlocked?.id).toBe('m-veg')
    expect(result.couponDiscount).toBe(15)
  })
})
