// Coverage for the reported bug: a matched payment offer's usage was
// recorded the instant an order row was created — including for a genuine
// ONLINE/WALLET payment, before it had actually been confirmed. A payment
// that then failed still permanently burned the customer's redemption
// against the offer's per-user cap, for a payment they never completed —
// the exact same bug already fixed for coupons (see
// coupons.deferred-usage.test.js). orders.service.js now only calls
// recordUsage() immediately for COD/wallet-fully-covers-order;
// ONLINE/WALLET confirmation call the new recordUsageForOrder() below once
// payment actually succeeds.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const cashbackRepoMock = vi.hoisted(() => ({ findActiveByOrder: vi.fn() }))
vi.mock('../../../src/modules/cashback/cashback.repository.js', () => ({
  CashbackRepository: vi.fn(() => cashbackRepoMock),
}))

const ordersRepoMock = vi.hoisted(() => ({ findById: vi.fn() }))
vi.mock('../../../src/modules/orders/orders.repository.js', () => ({
  OrdersRepository: vi.fn(() => ordersRepoMock),
}))

import { PaymentOffersService } from '../../../src/modules/payment-offers/payment-offers.service.js'

function makeRepoMock(overrides = {}) {
  return {
    recordUsage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PaymentOffersService.recordUsageForOrder — reads the matched offer off the pending cashback row (positive)', () => {
  it('records usage for the PAYMENT_OFFER cashback row\'s sourceId/order userId', async () => {
    cashbackRepoMock.findActiveByOrder.mockResolvedValue([
      { sourceType: 'PAYMENT_OFFER', sourceId: 'offer-1', orderId: 'order-1' },
    ])
    ordersRepoMock.findById.mockResolvedValue({ id: 'order-1', userId: 'user-1' })
    const repo = makeRepoMock()
    const service = new PaymentOffersService(repo)

    await service.recordUsageForOrder('order-1')

    expect(repo.recordUsage).toHaveBeenCalledWith('offer-1', 'user-1', 'order-1')
  })

  it('picks the PAYMENT_OFFER row out from among other cashback sources on the same order', async () => {
    cashbackRepoMock.findActiveByOrder.mockResolvedValue([
      { sourceType: 'FIRST_TIME_OFFER', sourceId: 'fto-1', orderId: 'order-1' },
      { sourceType: 'PAYMENT_OFFER', sourceId: 'offer-2', orderId: 'order-1' },
    ])
    ordersRepoMock.findById.mockResolvedValue({ id: 'order-1', userId: 'user-1' })
    const repo = makeRepoMock()
    const service = new PaymentOffersService(repo)

    await service.recordUsageForOrder('order-1')

    expect(repo.recordUsage).toHaveBeenCalledWith('offer-2', 'user-1', 'order-1')
  })
})

describe('PaymentOffersService.recordUsageForOrder — no-ops safely (negative)', () => {
  it('does nothing when no PAYMENT_OFFER cashback row exists for the order (most orders)', async () => {
    cashbackRepoMock.findActiveByOrder.mockResolvedValue([])
    const repo = makeRepoMock()
    const service = new PaymentOffersService(repo)

    await service.recordUsageForOrder('order-1')

    expect(ordersRepoMock.findById).not.toHaveBeenCalled()
    expect(repo.recordUsage).not.toHaveBeenCalled()
  })

  it('does nothing when the order id does not resolve to a real order', async () => {
    cashbackRepoMock.findActiveByOrder.mockResolvedValue([
      { sourceType: 'PAYMENT_OFFER', sourceId: 'offer-1', orderId: 'missing-order' },
    ])
    ordersRepoMock.findById.mockResolvedValue(null)
    const repo = makeRepoMock()
    const service = new PaymentOffersService(repo)

    await service.recordUsageForOrder('missing-order')

    expect(repo.recordUsage).not.toHaveBeenCalled()
  })
})
