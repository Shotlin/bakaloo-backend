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
 * "first-time". It must now exclude only CANCELLED — including PENDING,
 * since a reward is consumed the moment an order is placed, not once
 * delivered — relying on payment-expiry.worker.js to auto-cancel any
 * order genuinely abandoned mid-payment instead of excluding PENDING here.
 */
describe('CartMilestonesRepository.hasPriorOrder — gated on placement, not delivery', () => {
  it("excludes only CANCELLED, counts PENDING, and never references delivered_at", async () => {
    queryMock.mockClear()
    const repo = new CartMilestonesRepository()

    await repo.hasPriorOrder('user-1')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/status\s*!=\s*'CANCELLED'/i)
    expect(sql).not.toMatch(/PENDING/i)
    expect(sql).not.toMatch(/delivered_at/i)
    expect(params).toEqual(['user-1'])
  })
})

/**
 * Regression coverage for getUserUsageCount() — used by usageLimitPerUser.
 * recordUsage() fires at order creation, before payment is confirmed, so a
 * usage row can belong to an order the customer later cancelled (Razorpay
 * checkout cancel, or the payment-expiry worker's auto-cancel). Previously
 * a bare COUNT(*), so one cancelled attempt permanently burned a
 * usageLimitPerUser=1 slot on a FIRST_TIME milestone even though
 * hasPriorOrder() above already correctly says that customer is still
 * eligible. Reported: "first order failed [payment cancelled]... first-time
 * [milestone] offer show[s] gone."
 */
describe('CartMilestonesRepository.getUserUsageCount — excludes cancelled orders', () => {
  it('joins against orders and excludes CANCELLED, but still counts usages with no linked order', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [{ count: 0 }] })
    const repo = new CartMilestonesRepository()

    await repo.getUserUsageCount('milestone-1', 'user-1')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/LEFT JOIN orders/i)
    expect(sql).toMatch(/o\.id IS NULL OR o\.status != 'CANCELLED'/)
    expect(params).toEqual(['milestone-1', 'user-1'])
  })
})
