import { describe, expect, it, vi } from 'vitest'

// Regression coverage: reordering after a cancelled/failed ONLINE or WALLET
// payment used to double the customer's cart quantity. Root cause — the
// cart is deliberately left populated for those payment methods until
// payment confirms (see OrdersService.create's cart-clear deferral), but
// the Flutter app's cancel+reorder retry-safety-net (fired e.g. when the
// customer backs out of the Razorpay sheet) called reorder() anyway, which
// re-added the full ordered quantity via the delta-based
// cartService.addItem on top of what was already sitting there.

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
  smsQueue: { add: vi.fn() },
  themeQueue: { add: vi.fn() },
  allocationQueue: { add: vi.fn() },
  settlementQueue: { add: vi.fn() },
  payoutQueue: { add: vi.fn() },
  stockNotificationsQueue: { add: vi.fn() },
  scheduledOrdersQueue: { add: vi.fn() },
  reportPrecomputeQueue: { add: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OrdersRepository } from '../../../src/modules/orders/orders.repository.js'
import { OrdersService } from '../../../src/modules/orders/orders.service.js'

const USER_ID = '11111111-1111-1111-1111-111111111111'
const ORDER_ID = '33333333-3333-3333-3333-333333333333'
const PRODUCT_ID = '44444444-4444-4444-4444-444444444444'
const SHOP_ID = '55555555-5555-5555-5555-555555555555'

function makeService({ order, existingCart }) {
  const cartRepository = { getCart: vi.fn(async () => existingCart) }
  const cartService = {
    addItem: vi.fn(async () => ({ success: true })),
    getCart: vi.fn(async () => ({ items: [] })),
  }
  // OrdersRepository's own constructor does not touch the DB — safe to
  // instantiate directly rather than stub every method.
  const repository = Object.assign(new OrdersRepository(), {
    findByIdAndUser: vi.fn(async () => order),
  })
  const service = new OrdersService(repository, null, {
    cartRepository,
    cartService,
  })
  return { service, cartRepository, cartService }
}

describe('OrdersService.reorder', () => {
  it('does not re-add anything when the cart already has the full ordered quantity (cancelled ONLINE/WALLET payment retry)', async () => {
    const order = {
      id: ORDER_ID,
      shopId: SHOP_ID,
      items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, quantity: 2 }],
    }
    const existingCart = [{ productId: PRODUCT_ID, shopId: SHOP_ID, quantity: 2 }]
    const { service, cartService } = makeService({ order, existingCart })

    const result = await service.reorder(USER_ID, ORDER_ID)

    expect(cartService.addItem).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('tops up only the shortfall when the cart has fewer than the ordered quantity', async () => {
    const order = {
      id: ORDER_ID,
      shopId: SHOP_ID,
      items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, quantity: 3 }],
    }
    const existingCart = [{ productId: PRODUCT_ID, shopId: SHOP_ID, quantity: 1 }]
    const { service, cartService } = makeService({ order, existingCart })

    await service.reorder(USER_ID, ORDER_ID)

    expect(cartService.addItem).toHaveBeenCalledTimes(1)
    expect(cartService.addItem).toHaveBeenCalledWith(USER_ID, {
      productId: PRODUCT_ID,
      shopId: SHOP_ID,
      quantity: 2,
    })
  })

  it('adds the full ordered quantity when the cart is empty (reordering a past, already-cleared order)', async () => {
    const order = {
      id: ORDER_ID,
      shopId: SHOP_ID,
      items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, quantity: 2 }],
    }
    const { service, cartService } = makeService({ order, existingCart: [] })

    await service.reorder(USER_ID, ORDER_ID)

    expect(cartService.addItem).toHaveBeenCalledWith(USER_ID, {
      productId: PRODUCT_ID,
      shopId: SHOP_ID,
      quantity: 2,
    })
  })

  it('returns an error when the order does not belong to the user / does not exist', async () => {
    const { service } = makeService({ order: null, existingCart: [] })

    const result = await service.reorder(USER_ID, ORDER_ID)

    expect(result).toEqual({ success: false, message: 'Order not found' })
  })
})
