import { describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn().mockResolvedValue({ rows: [{ has_prior: false }] })

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { CartMilestonesRepository } from '../../../src/modules/cart-milestones/cart-milestones.repository.js'

/**
 * Regression coverage for hasPriorOrder() — used by FIRST_TIME cart
 * milestones. Previously gated on `delivered_at IS NOT NULL`, which
 * correctly stopped a stuck-PENDING failed-payment order from permanently
 * costing a genuine first-time customer their eligibility, but reopened a
 * worse hole: nothing stopped placing several orders back-to-back before
 * the first one ever reached DELIVERED, each still counting as
 * "first-time". It must now exclude only CANCELLED and PENDING, so any
 * order that's actually progressed (CONFIRMED and beyond) counts.
 */
describe('CartMilestonesRepository.hasPriorOrder — gated on real progress, not just delivery', () => {
  it("excludes only CANCELLED and PENDING, and never references delivered_at", async () => {
    queryMock.mockClear()
    const repo = new CartMilestonesRepository()

    await repo.hasPriorOrder('user-1')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/status\s+NOT\s+IN\s*\(\s*'CANCELLED'\s*,\s*'PENDING'\s*\)/i)
    expect(sql).not.toMatch(/delivered_at/i)
    expect(params).toEqual(['user-1'])
  })
})
