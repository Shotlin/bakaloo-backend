import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/utils/activityLogger.js', () => ({
  logAdminActivity: vi.fn(),
}))

const findByIdMock = vi.fn()
const getOrderPaymentMock = vi.fn()
vi.mock('../../../../src/modules/admin/orders/orders.repository.js', () => ({
  AdminOrdersRepository: vi.fn().mockImplementation(() => ({
    findById: findByIdMock,
    getOrderPayment: getOrderPaymentMock,
  })),
}))

const creditWalletMock = vi.fn(async () => ({}))
vi.mock('../../../../src/modules/admin/customers/customers.repository.js', () => ({
  AdminCustomersRepository: vi.fn().mockImplementation(() => ({
    creditWallet: creditWalletMock,
  })),
}))

const paymentsRefundMock = vi.fn(async () => ({ success: true }))
vi.mock('../../../../src/modules/payments/payments.service.js', () => ({
  PaymentsService: vi.fn().mockImplementation(() => ({
    refund: paymentsRefundMock,
  })),
}))
vi.mock('../../../../src/modules/payments/payments.repository.js', () => ({
  PaymentsRepository: vi.fn().mockImplementation(() => ({})),
}))

const { AdminRefundRequestsService } = await import(
  '../../../../src/modules/admin/refund-requests/refund-requests.service.js'
)

const REQUEST_ID = '11111111-1111-1111-1111-111111111111'
const ORDER_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = '33333333-3333-3333-3333-333333333333'
const ADMIN_ID = '44444444-4444-4444-4444-444444444444'
const PAYMENT_ID = '55555555-5555-5555-5555-555555555555'

function makeOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    order_number: 'GRO-TEST-001',
    total_amount: '500.00',
    wallet_amount_used: '0',
    ...overrides,
  }
}

function makeRequest(overrides = {}) {
  return {
    id: REQUEST_ID,
    order_id: ORDER_ID,
    user_id: USER_ID,
    item_scope: 'ALL',
    items: null,
    status: 'PENDING',
    order_number: 'GRO-TEST-001',
    ...overrides,
  }
}

function makeService({ request, order, payment = null }) {
  const repository = {
    findById: vi.fn(async () => request),
    updateStatus: vi.fn(async (id, opts) => ({ ...request, status: opts.status, refund_amount: opts.refundAmount, refund_to: opts.refundTo })),
  }
  findByIdMock.mockResolvedValue(order)
  getOrderPaymentMock.mockResolvedValue(payment)
  const service = new AdminRefundRequestsService(repository, null)
  return { service, repository }
}

beforeEach(() => {
  creditWalletMock.mockClear()
  paymentsRefundMock.mockClear()
  findByIdMock.mockReset()
  getOrderPaymentMock.mockReset()
})

describe('AdminRefundRequestsService.approve — refund amount calculation', () => {
  it('rejects approving a request that is not PENDING', async () => {
    const { service } = makeService({
      request: makeRequest({ status: 'APPROVED' }),
      order: makeOrder(),
    })

    await expect(
      service.approve(REQUEST_ID, { refundTo: 'wallet' }, ADMIN_ID, '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(creditWalletMock).not.toHaveBeenCalled()
  })

  it('refunds the full paid amount for an ALL-item request (COD order — subtracts wallet_amount_used)', async () => {
    const { service } = makeService({
      request: makeRequest({ item_scope: 'ALL' }),
      order: makeOrder({ total_amount: '500.00', wallet_amount_used: '50.00' }),
      payment: null,
    })

    const result = await service.approve(REQUEST_ID, { refundTo: 'wallet' }, ADMIN_ID, '127.0.0.1')

    expect(creditWalletMock).toHaveBeenCalledWith(USER_ID, 450, expect.any(String))
    expect(result.refund_amount).toBe(450)
  })

  it('refunds only the sum of the selected items for a SPECIFIC-item request, ignoring the rest of the order', async () => {
    const { service } = makeService({
      request: makeRequest({
        item_scope: 'SPECIFIC',
        items: [
          { productId: 'p1', name: 'Milk', quantity: 1, total: 60 },
          { productId: 'p2', name: 'Bread', quantity: 1, total: 40 },
        ],
      }),
      order: makeOrder({ total_amount: '500.00', wallet_amount_used: '0' }),
      payment: { id: PAYMENT_ID, amount: '500.00', status: 'PAID', razorpay_payment_id: null },
    })

    const result = await service.approve(REQUEST_ID, { refundTo: 'wallet' }, ADMIN_ID, '127.0.0.1')

    expect(creditWalletMock).toHaveBeenCalledWith(USER_ID, 100, expect.any(String))
    expect(result.refund_amount).toBe(100)
  })

  it('caps a SPECIFIC-item refund at the actual paid amount, never exceeding what was collected', async () => {
    const { service } = makeService({
      request: makeRequest({
        item_scope: 'SPECIFIC',
        items: [{ productId: 'p1', name: 'Overpriced snapshot item', quantity: 1, total: 9999 }],
      }),
      order: makeOrder({ total_amount: '300.00', wallet_amount_used: '0' }),
      payment: { id: PAYMENT_ID, amount: '300.00', status: 'PAID', razorpay_payment_id: null },
    })

    const result = await service.approve(REQUEST_ID, { refundTo: 'wallet' }, ADMIN_ID, '127.0.0.1')

    expect(creditWalletMock).toHaveBeenCalledWith(USER_ID, 300, expect.any(String))
    expect(result.refund_amount).toBe(300)
  })

  it('routes refundTo=original through PaymentsService.refund with the computed amount for a captured Razorpay payment', async () => {
    const { service } = makeService({
      request: makeRequest({
        item_scope: 'SPECIFIC',
        items: [{ productId: 'p1', name: 'Milk', quantity: 1, total: 60 }],
      }),
      order: makeOrder({ total_amount: '500.00' }),
      payment: { id: PAYMENT_ID, amount: '500.00', status: 'PAID', razorpay_payment_id: 'pay_abc123' },
    })

    const result = await service.approve(REQUEST_ID, { refundTo: 'original' }, ADMIN_ID, '127.0.0.1')

    expect(paymentsRefundMock).toHaveBeenCalledWith(
      PAYMENT_ID,
      expect.objectContaining({ amount: 60, reason: expect.any(String) })
    )
    expect(creditWalletMock).not.toHaveBeenCalled()
    expect(result.refund_amount).toBe(60)
  })

  it('rejects refundTo=original when there is no captured gateway payment (e.g. COD)', async () => {
    const { service } = makeService({
      request: makeRequest({ item_scope: 'ALL' }),
      order: makeOrder(),
      payment: null,
    })

    await expect(
      service.approve(REQUEST_ID, { refundTo: 'original' }, ADMIN_ID, '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(paymentsRefundMock).not.toHaveBeenCalled()
  })
})

describe('AdminRefundRequestsService.reject', () => {
  it('rejects a pending request without moving any money', async () => {
    const repository = {
      findById: vi.fn(async () => makeRequest({ status: 'PENDING' })),
      updateStatus: vi.fn(async (id, opts) => ({ status: opts.status, admin_note: opts.adminNote })),
    }
    const service = new AdminRefundRequestsService(repository, null)

    const result = await service.reject(REQUEST_ID, { adminNote: 'Not eligible' }, ADMIN_ID, '127.0.0.1')

    expect(result.status).toBe('REJECTED')
    expect(creditWalletMock).not.toHaveBeenCalled()
    expect(paymentsRefundMock).not.toHaveBeenCalled()
  })

  it('rejects trying to reject a request that is already processed', async () => {
    const repository = {
      findById: vi.fn(async () => makeRequest({ status: 'APPROVED' })),
      updateStatus: vi.fn(),
    }
    const service = new AdminRefundRequestsService(repository, null)

    await expect(
      service.reject(REQUEST_ID, {}, ADMIN_ID, '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(repository.updateStatus).not.toHaveBeenCalled()
  })
})
