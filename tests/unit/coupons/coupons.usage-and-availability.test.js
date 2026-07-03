// Coverage for two fixes made alongside coupon targeting:
//  1. recordUsage() now persists shop_id/discount_amount on coupon_usages
//     (previously always NULL on the live write path — migration 044
//     schema drift).
//  2. getAvailable() now hides segment/individual/first-time coupons from
//     users who aren't eligible for them, instead of listing a code the
//     user would only see rejected at apply time.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CouponsService } from '../../../src/modules/coupons/coupons.service.js'

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SEGMENT_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function makeRepoMock(overrides = {}) {
  return {
    findByCode: vi.fn(),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    findAvailable: vi.fn().mockResolvedValue([]),
    getUserUsageCount: vi.fn().mockResolvedValue(0),
    isTargetUser: vi.fn().mockResolvedValue(false),
    hasPriorOrder: vi.fn().mockResolvedValue(false),
    ...overrides,
  }
}

function makeSegmentsRepoMock(overrides = {}) {
  return { isMember: vi.fn().mockResolvedValue(false), ...overrides }
}

describe('CouponsService.recordUsage — persists shop/discount instead of leaving them NULL (positive)', () => {
  it('passes shopId and discountAmount through to the repository write', async () => {
    const repo = makeRepoMock({
      findByCode: vi.fn().mockResolvedValue({ id: UUID_A, code: 'SAVE50' }),
    })
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    await service.recordUsage('SAVE50', UUID_A, 'order-1', { shopId: 'shop-1', discountAmount: 50 })

    expect(repo.recordUsage).toHaveBeenCalledWith(UUID_A, UUID_A, 'order-1', {
      shopId: 'shop-1',
      discountAmount: 50,
    })
  })

  it('still no-ops safely for demo coupons (negative — non-UUID id must not reach the DB write)', async () => {
    const repo = makeRepoMock({
      findByCode: vi.fn().mockResolvedValue({ id: 'demo-coupon-bakaloo50', code: 'BAKALOO50' }),
    })
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    await service.recordUsage('BAKALOO50', UUID_A, 'order-1', { shopId: 'shop-1', discountAmount: 50 })

    expect(repo.recordUsage).not.toHaveBeenCalled()
  })
})

describe('CouponsService.getAvailable — hides coupons the user is not eligible for (positive/negative)', () => {
  let repo, segmentsRepo, service

  beforeEach(() => {
    repo = makeRepoMock()
    segmentsRepo = makeSegmentsRepoMock()
    service = new CouponsService(repo, segmentsRepo)
  })

  it('excludes a SEGMENT coupon for a user who is not a member (negative)', async () => {
    repo.findAvailable = vi.fn().mockResolvedValue([
      { id: UUID_A, code: 'VIPONLY', targetType: 'SEGMENT', targetSegmentId: SEGMENT_UUID, usageLimitPerUser: 1, discountType: 'FLAT', discountValue: 10 },
    ])
    segmentsRepo.isMember = vi.fn().mockResolvedValue(false)

    const available = await service.getAvailable(UUID_A)

    expect(available.find((c) => c.code === 'VIPONLY')).toBeUndefined()
  })

  it('includes a SEGMENT coupon for an actual member (positive)', async () => {
    repo.findAvailable = vi.fn().mockResolvedValue([
      { id: UUID_A, code: 'VIPONLY', targetType: 'SEGMENT', targetSegmentId: SEGMENT_UUID, usageLimitPerUser: 1, discountType: 'FLAT', discountValue: 10 },
    ])
    segmentsRepo.isMember = vi.fn().mockResolvedValue(true)

    const available = await service.getAvailable(UUID_A)

    expect(available.find((c) => c.code === 'VIPONLY')).toBeDefined()
  })

  it('still includes a plain ALL-type coupon regardless of targeting (regression)', async () => {
    repo.findAvailable = vi.fn().mockResolvedValue([
      { id: UUID_A, code: 'EVERY10', targetType: 'ALL', usageLimitPerUser: 1, discountType: 'FLAT', discountValue: 10 },
    ])

    const available = await service.getAvailable(UUID_A)

    expect(available.find((c) => c.code === 'EVERY10')).toBeDefined()
  })
})
