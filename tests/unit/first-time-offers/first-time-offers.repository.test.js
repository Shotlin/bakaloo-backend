import { describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn().mockResolvedValue({ rows: [{ has_prior: false }] })

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { FirstTimeOffersRepository } from '../../../src/modules/first-time-offers/first-time-offers.repository.js'

/**
 * Regression coverage for hasPriorOrder() gating the first-order offer.
 * Previously checked `delivered_at IS NOT NULL`, which correctly stopped a
 * stuck-PENDING failed-payment order from permanently costing a genuine
 * first-time customer their offer, but reopened a worse hole: nothing
 * stopped placing several orders back-to-back before the first one ever
 * reached DELIVERED, each still counting as "first-time" (reported: the
 * same first-time discount applied on three separate real orders for one
 * customer). It must now exclude only CANCELLED and PENDING, so any order
 * that's actually progressed (CONFIRMED and beyond) counts.
 */
describe("FirstTimeOffersRepository.hasPriorOrder — gated on real progress, not just delivery", () => {
  it('excludes only CANCELLED and PENDING, and never references delivered_at', async () => {
    queryMock.mockClear()
    const repo = new FirstTimeOffersRepository()

    await repo.hasPriorOrder('user-1')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/status\s+NOT\s+IN\s*\(\s*'CANCELLED'\s*,\s*'PENDING'\s*\)/i)
    expect(sql).not.toMatch(/delivered_at/i)
    expect(params).toEqual(['user-1'])
  })
})
