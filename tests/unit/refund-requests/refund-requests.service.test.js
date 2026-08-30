import { describe, expect, it, vi, beforeEach } from 'vitest'

const findByIdAndUserMock = vi.fn()
vi.mock('../../../src/modules/orders/orders.repository.js', () => ({
  OrdersRepository: vi.fn().mockImplementation(() => ({
    findByIdAndUser: findByIdAndUserMock,
  })),
}))

const { RefundRequestsService } = await import(
  '../../../src/modules/refund-requests/refund-requests.service.js'
)

const ORDER_ID = 'order-1'
const USER_ID = 'user-1'
const REQUEST_ID = 'request-1'

function makeOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    orderNumber: 'GRO-TEST-001',
    status: 'DELIVERED',
    paymentStatus: 'PAID',
    ...overrides,
  }
}

function makeRepository(overrides = {}) {
  return {
    findLatestByOrder: vi.fn(async () => null),
    getMatchingOrderItems: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: REQUEST_ID, order_id: ORDER_ID })),
    findByIdAndUser: vi.fn(async () => null),
    cancel: vi.fn(async () => ({ id: REQUEST_ID, status: 'CANCELLED' })),
    ...overrides,
  }
}

beforeEach(() => {
  findByIdAndUserMock.mockReset()
  findByIdAndUserMock.mockResolvedValue(makeOrder())
})

describe('RefundRequestsService.createRequest — duplicate guard', () => {
  it('allows a request when none exists yet for this order', async () => {
    const repository = makeRepository()
    const service = new RefundRequestsService(repository, null)

    const result = await service.createRequest(USER_ID, {
      orderId: ORDER_ID,
      itemScope: 'ALL',
      description: 'Item arrived damaged',
    })

    expect(repository.create).toHaveBeenCalled()
    expect(result.id).toBe(REQUEST_ID)
  })

  it('rejects a new request while one is already PENDING', async () => {
    const repository = makeRepository({
      findLatestByOrder: vi.fn(async () => ({ status: 'PENDING' })),
    })
    const service = new RefundRequestsService(repository, null)

    await expect(
      service.createRequest(USER_ID, { orderId: ORDER_ID, itemScope: 'ALL', description: 'x' })
    ).rejects.toMatchObject({ statusCode: 400, message: 'A refund request is already pending for this order' })
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('rejects a new request once the previous one was APPROVED — already refunded', async () => {
    const repository = makeRepository({
      findLatestByOrder: vi.fn(async () => ({ status: 'APPROVED' })),
    })
    const service = new RefundRequestsService(repository, null)

    await expect(
      service.createRequest(USER_ID, { orderId: ORDER_ID, itemScope: 'ALL', description: 'x' })
    ).rejects.toMatchObject({ statusCode: 400, message: 'This order has already been refunded' })
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('rejects a new request once the previous one was REJECTED — no resubmitting the same complaint', async () => {
    const repository = makeRepository({
      findLatestByOrder: vi.fn(async () => ({ status: 'REJECTED' })),
    })
    const service = new RefundRequestsService(repository, null)

    await expect(
      service.createRequest(USER_ID, { orderId: ORDER_ID, itemScope: 'ALL', description: 'x' })
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('allows a fresh request once the previous one was CANCELLED by the customer', async () => {
    const repository = makeRepository({
      findLatestByOrder: vi.fn(async () => ({ status: 'CANCELLED' })),
    })
    const service = new RefundRequestsService(repository, null)

    await service.createRequest(USER_ID, { orderId: ORDER_ID, itemScope: 'ALL', description: 'x' })

    expect(repository.create).toHaveBeenCalled()
  })
})

describe('RefundRequestsService.cancelRequest', () => {
  it('cancels a PENDING request the caller owns', async () => {
    const repository = makeRepository({
      findByIdAndUser: vi.fn(async () => ({ id: REQUEST_ID, user_id: USER_ID, order_id: ORDER_ID, status: 'PENDING' })),
    })
    const service = new RefundRequestsService(repository, null)

    const result = await service.cancelRequest(USER_ID, REQUEST_ID)

    expect(repository.cancel).toHaveBeenCalledWith(REQUEST_ID)
    expect(result.status).toBe('CANCELLED')
  })

  it('rejects cancelling a request that does not belong to the caller (or does not exist)', async () => {
    const repository = makeRepository({ findByIdAndUser: vi.fn(async () => null) })
    const service = new RefundRequestsService(repository, null)

    await expect(service.cancelRequest(USER_ID, REQUEST_ID)).rejects.toMatchObject({ statusCode: 404 })
    expect(repository.cancel).not.toHaveBeenCalled()
  })

  it('rejects cancelling a request that has already been approved', async () => {
    const repository = makeRepository({
      findByIdAndUser: vi.fn(async () => ({ id: REQUEST_ID, user_id: USER_ID, order_id: ORDER_ID, status: 'APPROVED' })),
    })
    const service = new RefundRequestsService(repository, null)

    await expect(service.cancelRequest(USER_ID, REQUEST_ID)).rejects.toMatchObject({ statusCode: 400 })
    expect(repository.cancel).not.toHaveBeenCalled()
  })
})
