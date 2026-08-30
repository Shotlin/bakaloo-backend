// Coverage for CartMilestonesService — the graduated cart-value ladder
// that powers the mobile Smart Bottom Bar's progress state. Constructor
// injection (repo + segmentsRepo), no database mocking needed.

import { describe, expect, it, vi } from 'vitest'
import { CartMilestonesService } from '../../../src/modules/cart-milestones/cart-milestones.service.js'

const USER_ID = 'user-1'
const PROD_MILK = 'prod-milk'
const PROD_TOMATO = 'prod-tomato'

const cartItems = [
  { productId: PROD_MILK, quantity: 2, effectivePrice: 30, lineTotal: 60 },
  { productId: PROD_TOMATO, quantity: 5, effectivePrice: 10, lineTotal: 50 },
]
// cart total = 110; dairy-only (milk) subtotal = 60

function tier(overrides = {}) {
  return {
    id: 'm-1',
    name: 'Tier',
    minCartAmount: 299,
    rewardType: 'CASHBACK',
    rewardValue: 20,
    maxDiscount: null,
    unlockCouponId: null,
    messageBefore: 'Add ₹{amount} more to unlock {name}',
    messageAfter: 'Unlocked!',
    applicableUserType: 'ALL',
    applicableSegmentId: null,
    stackableWithCoupon: true,
    cashbackCreditTrigger: 'ORDER_DELIVERED',
    ...overrides,
  }
}

function makeRepoMock(overrides = {}) {
  return {
    findAllActive: vi.fn().mockResolvedValue([]),
    hasPriorOrder: vi.fn().mockResolvedValue(false),
    getUserUsageCount: vi.fn().mockResolvedValue(0),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()),
    getCategoryNames: vi.fn().mockResolvedValue([]),
    getProductNames: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function makeSegmentsRepoMock() {
  return { isMember: vi.fn().mockResolvedValue(false) }
}

describe('CartMilestonesService.getProgress — graduated ladder (positive)', () => {
  it('picks the highest unlocked tier and the nearest next tier for a cart in between', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-299', minCartAmount: 299, name: 'Free delivery tier' }),
        tier({ id: 'm-500', minCartAmount: 500, name: '₹20 cashback tier' }),
        tier({ id: 'm-999', minCartAmount: 999, name: '₹100 cashback tier' }),
      ]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 600)

    expect(progress.unlocked.id).toBe('m-500')
    expect(progress.next.id).toBe('m-999')
    expect(progress.next.amountToUnlock).toBe(399)
  })

  it('unlocked is null when the cart is below every tier (negative)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ minCartAmount: 299 })]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 100)

    expect(progress.unlocked).toBeNull()
    expect(progress.next.amountToUnlock).toBe(199)
  })

  it('next is null when the cart already clears every tier (positive — top of ladder)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ id: 'm-999', minCartAmount: 999 })]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 1500)

    expect(progress.unlocked.id).toBe('m-999')
    expect(progress.next).toBeNull()
  })

  it('substitutes {amount} in the message template', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ minCartAmount: 299, messageBefore: 'Add ₹{amount} more to unlock FREE DELIVERY' }),
      ]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 239)

    expect(progress.next.message).toBe('Add ₹60 more to unlock FREE DELIVERY')
  })
})

describe('CartMilestonesService.getProgress — eligibility filtering (negative)', () => {
  it('excludes a FIRST_TIME-only milestone for a repeat customer', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ minCartAmount: 100, applicableUserType: 'FIRST_TIME' })]),
      hasPriorOrder: vi.fn().mockResolvedValue(true),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked).toBeNull()
    expect(progress.next).toBeNull()
  })

  it('excludes a SEGMENT-only milestone for a non-member', async () => {
    const segmentsRepo = makeSegmentsRepoMock()
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ minCartAmount: 100, applicableUserType: 'SEGMENT', applicableSegmentId: 'seg-1' }),
      ]),
    })
    const service = new CartMilestonesService(repo, segmentsRepo)

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked).toBeNull()
    expect(segmentsRepo.isMember).toHaveBeenCalledWith('seg-1', USER_ID)
  })
})

describe('CartMilestonesService — "All users" milestone with an excluded segment (106_cart_milestone_excluded_segment, avoids double-dipping a segment that already has its own dedicated milestone)', () => {
  it('excludes an ALL-users milestone for a member of the excluded segment (negative)', async () => {
    const segmentsRepo = { isMember: vi.fn().mockResolvedValue(true) }
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-1', minCartAmount: 100, applicableUserType: 'ALL', excludedSegmentId: 'seg-vip' }),
      ]),
    })
    const service = new CartMilestonesService(repo, segmentsRepo)

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked).toBeNull()
    expect(segmentsRepo.isMember).toHaveBeenCalledWith('seg-vip', USER_ID)
  })

  it('still includes an ALL-users milestone for a non-member of the excluded segment (positive)', async () => {
    const segmentsRepo = { isMember: vi.fn().mockResolvedValue(false) }
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-1', minCartAmount: 100, applicableUserType: 'ALL', excludedSegmentId: 'seg-vip' }),
      ]),
    })
    const service = new CartMilestonesService(repo, segmentsRepo)

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked?.id).toBe('m-1')
  })

  it('never checks segment membership when no segment is excluded (unaffected default case)', async () => {
    const segmentsRepo = makeSegmentsRepoMock()
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-1', minCartAmount: 100, applicableUserType: 'ALL', excludedSegmentId: null }),
      ]),
    })
    const service = new CartMilestonesService(repo, segmentsRepo)

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked?.id).toBe('m-1')
    expect(segmentsRepo.isMember).not.toHaveBeenCalled()
  })

  it('a FIRST_TIME milestone ignores excludedSegmentId entirely — only ALL consults it', async () => {
    const segmentsRepo = { isMember: vi.fn().mockResolvedValue(true) }
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-1', minCartAmount: 100, applicableUserType: 'FIRST_TIME', excludedSegmentId: 'seg-vip' }),
      ]),
      hasPriorOrder: vi.fn().mockResolvedValue(false),
    })
    const service = new CartMilestonesService(repo, segmentsRepo)

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked?.id).toBe('m-1')
    expect(segmentsRepo.isMember).not.toHaveBeenCalled()
  })
})

describe('CartMilestonesService — "All users" milestone excluding first-time customers (107_cart_milestone_exclude_first_time, prevents a brand-new customer double-dipping on both the First-Time Offer AND this milestone)', () => {
  it('excludes an ALL-users milestone for a first-time customer when the toggle is on (negative)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-1', minCartAmount: 100, applicableUserType: 'ALL', excludeFirstTimeUsers: true }),
      ]),
      hasPriorOrder: vi.fn().mockResolvedValue(false), // no prior order = first-time
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked).toBeNull()
    expect(repo.hasPriorOrder).toHaveBeenCalledWith(USER_ID)
  })

  it('still includes an ALL-users milestone for a returning customer even when the toggle is on (positive)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-1', minCartAmount: 100, applicableUserType: 'ALL', excludeFirstTimeUsers: true }),
      ]),
      hasPriorOrder: vi.fn().mockResolvedValue(true), // has a prior order = not first-time
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked?.id).toBe('m-1')
  })

  it('never checks first-order status when the toggle is off (unaffected default case)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-1', minCartAmount: 100, applicableUserType: 'ALL', excludeFirstTimeUsers: false }),
      ]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked?.id).toBe('m-1')
    expect(repo.hasPriorOrder).not.toHaveBeenCalled()
  })

  it('a FIRST_TIME milestone ignores excludeFirstTimeUsers entirely — only ALL consults it (would otherwise exclude everyone it targets)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-1', minCartAmount: 100, applicableUserType: 'FIRST_TIME', excludeFirstTimeUsers: true }),
      ]),
      hasPriorOrder: vi.fn().mockResolvedValue(false),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    // hasPriorOrder is still called once here — but for the FIRST_TIME
    // branch's own eligibility check, not the excludeFirstTimeUsers one.
    expect(progress.unlocked?.id).toBe('m-1')
    expect(repo.hasPriorOrder).toHaveBeenCalledTimes(1)
  })

  it('both exclusions can combine on the same ALL milestone — a first-time member of the excluded segment is blocked by either check', async () => {
    const segmentsRepo = { isMember: vi.fn().mockResolvedValue(false) }
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({
          id: 'm-1',
          minCartAmount: 100,
          applicableUserType: 'ALL',
          excludeFirstTimeUsers: true,
          excludedSegmentId: 'seg-vip',
        }),
      ]),
      hasPriorOrder: vi.fn().mockResolvedValue(false),
    })
    const service = new CartMilestonesService(repo, segmentsRepo)

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked).toBeNull()
    // Short-circuits on the first-time check — never even reaches the
    // segment-membership lookup.
    expect(segmentsRepo.isMember).not.toHaveBeenCalled()
  })
})

describe('CartMilestonesService — per-user usage limit (2026-07-04, "reward every order forever" fix)', () => {
  it('excludes a milestone once the user has hit its usageLimitPerUser (negative)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ minCartAmount: 100, usageLimitPerUser: 2 })]),
      getUserUsageCount: vi.fn().mockResolvedValue(2),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked).toBeNull()
  })

  it('still includes the milestone when usage is below the limit (positive)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ id: 'm-1', minCartAmount: 100, usageLimitPerUser: 2 })]),
      getUserUsageCount: vi.fn().mockResolvedValue(1),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked?.id).toBe('m-1')
  })

  it('never limits usage when usageLimitPerUser is null (default, unlimited — negative test for the check itself)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ id: 'm-1', minCartAmount: 100, usageLimitPerUser: null })]),
      getUserUsageCount: vi.fn().mockResolvedValue(9999),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked?.id).toBe('m-1')
    expect(repo.getUserUsageCount).not.toHaveBeenCalled()
  })

  it('recordUsage() delegates to the repository', async () => {
    const repo = makeRepoMock()
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    await service.recordUsage('m-1', USER_ID, 'order-1')

    expect(repo.recordUsage).toHaveBeenCalledWith('m-1', USER_ID, 'order-1')
  })
})

describe('CartMilestonesService.computeReward — each reward type (positive)', () => {
  const service = new CartMilestonesService(makeRepoMock(), makeSegmentsRepoMock())

  it('CASHBACK is capped at maxDiscount when set', () => {
    const reward = service.computeReward(tier({ rewardType: 'CASHBACK', rewardValue: 500, maxDiscount: 100 }), 2000)
    expect(reward.cashbackAmount).toBe(100)
  })

  it('FLAT_DISCOUNT is capped at the cart total', () => {
    const reward = service.computeReward(tier({ rewardType: 'FLAT_DISCOUNT', rewardValue: 5000 }), 300)
    expect(reward.discount).toBe(300)
  })

  it('COUPON_UNLOCK returns the coupon id', () => {
    const reward = service.computeReward(tier({ rewardType: 'COUPON_UNLOCK', unlockCouponId: 'coupon-9' }), 500)
    expect(reward).toEqual({ unlockCouponId: 'coupon-9', freeDelivery: false })
  })
})

describe('CartMilestonesService.computeReward — CASHBACK percentage mode (101_cart_milestone_reward_percent; reported bug: only a flat ₹ cashback was possible)', () => {
  const service = new CartMilestonesService(makeRepoMock(), makeSegmentsRepoMock())

  it('rewardPercent wins over the flat rewardValue when set (80% capped at ₹50)', () => {
    const reward = service.computeReward(
      tier({ rewardType: 'CASHBACK', rewardValue: 10, rewardPercent: 80, maxDiscount: 50 }),
      1000
    )
    expect(reward.cashbackAmount).toBe(50) // 80% of 1000 = 800, capped at 50
  })

  it('uses the flat rewardValue when rewardPercent is not set (unaffected default case)', () => {
    const reward = service.computeReward(
      tier({ rewardType: 'CASHBACK', rewardValue: 20, rewardPercent: null }),
      1000
    )
    expect(reward.cashbackAmount).toBe(20)
  })

  it('is uncapped when maxDiscount is not set', () => {
    const reward = service.computeReward(
      tier({ rewardType: 'CASHBACK', rewardValue: 0, rewardPercent: 10, maxDiscount: null }),
      1000
    )
    expect(reward.cashbackAmount).toBe(100)
  })
})

describe('CartMilestonesService.computeReward — FLAT_DISCOUNT ("Instant Discount") percentage mode, mirroring CASHBACK\'s percent/maxDiscount convention', () => {
  const service = new CartMilestonesService(makeRepoMock(), makeSegmentsRepoMock())

  it('rewardPercent wins over the flat rewardValue when set (20% capped at ₹50)', () => {
    const reward = service.computeReward(
      tier({ rewardType: 'FLAT_DISCOUNT', rewardValue: 10, rewardPercent: 20, maxDiscount: 50 }),
      1000
    )
    expect(reward.discount).toBe(50) // 20% of 1000 = 200, capped at 50
  })

  it('uses the flat rewardValue when rewardPercent is not set (unaffected default case)', () => {
    const reward = service.computeReward(
      tier({ rewardType: 'FLAT_DISCOUNT', rewardValue: 20, rewardPercent: null }),
      1000
    )
    expect(reward.discount).toBe(20)
  })

  it('is uncapped when maxDiscount is not set, but still clamped to the cart amount', () => {
    const uncapped = service.computeReward(
      tier({ rewardType: 'FLAT_DISCOUNT', rewardValue: 0, rewardPercent: 10, maxDiscount: null }),
      1000
    )
    expect(uncapped.discount).toBe(100)

    const clampedToCart = service.computeReward(
      tier({ rewardType: 'FLAT_DISCOUNT', rewardValue: 0, rewardPercent: 50, maxDiscount: null }),
      80
    )
    expect(clampedToCart.discount).toBe(40) // 50% of 80, never more than the cart itself
  })

  it('percentage discount is computed against the scoped subtotal when the milestone is scoped, not the raw cart total', () => {
    const reward = service.computeReward(
      { rewardType: 'FLAT_DISCOUNT', rewardPercent: 10, maxDiscount: null, scopedSubtotal: 60 },
      110
    )
    expect(reward.discount).toBe(6) // 10% of 60, not 110
  })
})

describe('CartMilestonesService.computeReward — grantsFreeDelivery toggle (100_cart_milestone_free_delivery_toggle)', () => {
  const service = new CartMilestonesService(makeRepoMock(), makeSegmentsRepoMock())

  it('is false by default for a CASHBACK milestone (negative)', () => {
    const reward = service.computeReward(tier({ rewardType: 'CASHBACK', rewardValue: 20 }), 500)
    expect(reward.freeDelivery).toBe(false)
  })

  it('carries through independently of rewardType when the toggle is on (positive)', () => {
    const reward = service.computeReward(
      tier({ rewardType: 'CASHBACK', rewardValue: 20, grantsFreeDelivery: true }),
      500
    )
    expect(reward.freeDelivery).toBe(true)
    expect(reward.cashbackAmount).toBe(20)
  })
})

describe('CartMilestonesService — category/product scope (103_cart_milestone_scope, mirroring coupons/first-time-offers)', () => {
  it('an unscoped milestone behaves exactly as before, evaluated against the full cart total', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ id: 'm-100', minCartAmount: 100 })]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 110, cartItems)

    expect(progress.unlocked.id).toBe('m-100')
    expect(repo.resolveMatchingProductIds).not.toHaveBeenCalled()
  })

  it('a scoped milestone only counts the matching slice of the cart toward its minCartAmount', async () => {
    // Dairy-only subtotal is 60 — a 100 min cart fails even though the
    // whole cart (110) would clear it.
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-dairy', minCartAmount: 100, applicableCategoryIds: ['cat-dairy'] }),
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set([PROD_MILK])),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 110, cartItems)

    expect(progress.unlocked).toBeNull()
    expect(progress.next.id).toBe('m-dairy')
    expect(progress.next.amountToUnlock).toBe(40) // 100 - 60, not 100 - 110
    expect(repo.resolveMatchingProductIds).toHaveBeenCalledWith(
      [PROD_MILK, PROD_TOMATO],
      { applicableCategoryIds: ['cat-dairy'], applicableProductIds: undefined }
    )
  })

  it('a scoped milestone unlocks and its reward is computed against the scoped subtotal, not the full cart total', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-dairy', minCartAmount: 50, rewardType: 'CASHBACK', rewardPercent: 10, maxDiscount: null, applicableCategoryIds: ['cat-dairy'] }),
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set([PROD_MILK])),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 110, cartItems)

    expect(progress.unlocked.id).toBe('m-dairy')
    expect(progress.unlocked.scopedSubtotal).toBe(60)
    expect(service.computeReward(progress.unlocked, 110)).toEqual({ cashbackAmount: 6, freeDelivery: false }) // 10% of 60, not 110
  })

  it("rejects a scoped milestone with minCartAmount 0 when nothing in the cart matches (0 >= 0 must not count as satisfied) — same guard as first-time-offers' reported bug", async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-veg', minCartAmount: 0, applicableCategoryIds: ['cat-veg'] }),
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()), // nothing in the cart is a vegetable
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 110, cartItems)

    expect(progress.unlocked).toBeNull()
    expect(progress.next.id).toBe('m-veg')
    expect(progress.next.amountToUnlock).toBe(0) // still needs a matching item, not more rupees
  })

  it('resolveForCheckout passes cartItems through so order placement respects the same scope', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-dairy', minCartAmount: 50, applicableCategoryIds: ['cat-dairy'] }),
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set([PROD_MILK])),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const milestone = await service.resolveForCheckout(USER_ID, 110, cartItems)

    expect(milestone.id).toBe('m-dairy')
    expect(milestone.scopedSubtotal).toBe(60)
  })

  it('a higher-value scoped tier can win over a lower, unscoped one it would not naturally follow in ascending order', async () => {
    // m-veg (min 200, scoped to veg — cart has none) stays unsatisfied,
    // while m-dairy (min 300, scoped to dairy — cart has 400 worth) IS
    // satisfied despite sitting later in the ascending min-amount order.
    const dairyItems = [{ productId: PROD_MILK, quantity: 1, effectivePrice: 400, lineTotal: 400 }]
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-veg', minCartAmount: 200, applicableCategoryIds: ['cat-veg'] }),
        tier({ id: 'm-dairy', minCartAmount: 300, applicableCategoryIds: ['cat-dairy'] }),
      ]),
      resolveMatchingProductIds: vi.fn()
        .mockResolvedValueOnce(new Set()) // m-veg: nothing matches
        .mockResolvedValueOnce(new Set([PROD_MILK])), // m-dairy: matches
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 400, dairyItems)

    expect(progress.unlocked.id).toBe('m-dairy')
  })

  it('getEligibleTiers omits scopedSubtotal when cartTotal is not provided (plain eligibility list, unaffected default case)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ id: 'm-1', applicableCategoryIds: ['cat-dairy'] })]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const tiers = await service.getEligibleTiers(USER_ID)

    expect(tiers[0].scopedSubtotal).toBeUndefined()
    expect(repo.resolveMatchingProductIds).not.toHaveBeenCalled()
  })
})

describe('CartMilestonesService.getProgress — scoped "next" message stays plain (product decision: no auto-generated scope breakdown in the message)', () => {
  it('does not append resolved category names to the next-tier message for a scoped milestone', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-veg', name: 'FREE DELIVERY', minCartAmount: 30, applicableCategoryIds: ['cat-veg'], messageBefore: null }),
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()), // nothing veg in the cart
      getCategoryNames: vi.fn().mockResolvedValue(['Fresh Vegetables']),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 110, cartItems)

    expect(progress.next.message).toBe('Add ₹30 more to unlock FREE DELIVERY')
    expect(repo.getCategoryNames).not.toHaveBeenCalled()
  })

  it('the shown amount never moves for out-of-scope items — matches the reported "adding ₹20/30/40 does nothing" behavior (by design)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-veg', minCartAmount: 30, applicableCategoryIds: ['cat-veg'] }),
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()), // cart has dairy only, never matches
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const smallerDairyCart = [{ productId: PROD_MILK, quantity: 1, effectivePrice: 20, lineTotal: 20 }]
    const biggerDairyCart = [{ productId: PROD_MILK, quantity: 3, effectivePrice: 20, lineTotal: 60 }]

    const progressSmall = await service.getProgress(USER_ID, 20, smallerDairyCart)
    const progressBig = await service.getProgress(USER_ID, 60, biggerDairyCart)

    // Adding ₹40 more of dairy (20 -> 60) must not budge the gap — only
    // vegetables count, and there are none in either cart.
    expect(progressSmall.next.amountToUnlock).toBe(30)
    expect(progressBig.next.amountToUnlock).toBe(30)
  })

  it('falls back to the plain message when the scoped category can no longer be resolved (e.g. deleted)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-veg', name: 'FREE DELIVERY', minCartAmount: 30, applicableCategoryIds: ['cat-deleted'], messageBefore: null }),
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()),
      getCategoryNames: vi.fn().mockResolvedValue([]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 110, cartItems)

    expect(progress.next.message).toBe('Add ₹30 more to unlock FREE DELIVERY')
  })

  it('an unscoped milestone never calls getCategoryNames/getProductNames (unaffected default case)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ id: 'm-1', minCartAmount: 300 })]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    await service.getProgress(USER_ID, 110, cartItems)

    expect(repo.getCategoryNames).not.toHaveBeenCalled()
    expect(repo.getProductNames).not.toHaveBeenCalled()
  })
})
