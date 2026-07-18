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
 * milestones — gating on `status != 'CANCELLED'`. Any non-cancelled order
 * (including one stuck PENDING forever after a failed online payment that
 * never formally transitions to CANCELLED) permanently killed FIRST_TIME
 * milestone eligibility even though nothing was ever delivered. It must now
 * check delivered_at instead, and must NOT reference order status at all.
 */
describe('CartMilestonesRepository.hasPriorOrder — gated on delivery, not status', () => {
  it('checks delivered_at IS NOT NULL and never references status', async () => {
    queryMock.mockClear()
    const repo = new CartMilestonesRepository()

    await repo.hasPriorOrder('user-1')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/delivered_at\s+IS\s+NOT\s+NULL/i)
    expect(sql).not.toMatch(/status/i)
    expect(params).toEqual(['user-1'])
  })
})
