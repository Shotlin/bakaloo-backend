import { describe, expect, it, vi, beforeEach } from 'vitest'

// Capture every query so we can assert on the exact SQL `findByUser` builds
// for the new `paymentFailed` filter — a Razorpay-expired/verify-failed
// payment writes status='CANCELLED', payment_status IN ('FAILED','EXPIRED'),
// indistinguishable from a plain cancellation unless this is filtered
// separately. See order_list_provider.dart's OrderFilter.failed on the
// mobile side for the matching UI.
const queryMock = vi.fn(async () => ({ rows: [{ count: '0' }] }))
vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
}))

const { OrdersRepository } = await import('../../../src/modules/orders/orders.repository.js')

beforeEach(() => {
  queryMock.mockClear()
})

describe('OrdersRepository.findByUser — paymentFailed filter', () => {
  it('paymentFailed=true isolates CANCELLED+FAILED/EXPIRED rows and ignores any status param', async () => {
    const repo = new OrdersRepository()
    await repo.findByUser('user-1', { limit: 10, offset: 0, status: 'DELIVERED', paymentFailed: true })

    const [countSql] = queryMock.mock.calls[0]
    expect(countSql).toMatch(/status = 'CANCELLED'/)
    expect(countSql).toMatch(/payment_status IN \('FAILED', 'EXPIRED'\)/)
    // The (ignored) status param must never leak into the query as a bind.
    expect(countSql).not.toMatch(/status = \$2/)
  })

  it('excludes payment-failed cancellations from the plain CANCELLED filter', async () => {
    const repo = new OrdersRepository()
    await repo.findByUser('user-1', { limit: 10, offset: 0, status: 'CANCELLED' })

    const [countSql, params] = queryMock.mock.calls[0]
    expect(countSql).toMatch(/status = \$2/)
    expect(params).toEqual(['user-1', 'CANCELLED'])
    expect(countSql).toMatch(/NOT \(status = 'CANCELLED' AND payment_status IN \('FAILED', 'EXPIRED'\)\)/)
  })

  it('excludes payment-failed cancellations from the unfiltered "All" list too', async () => {
    const repo = new OrdersRepository()
    await repo.findByUser('user-1', { limit: 10, offset: 0 })

    const [countSql, params] = queryMock.mock.calls[0]
    expect(params).toEqual(['user-1'])
    expect(countSql).toMatch(/NOT \(status = 'CANCELLED' AND payment_status IN \('FAILED', 'EXPIRED'\)\)/)
  })
})
