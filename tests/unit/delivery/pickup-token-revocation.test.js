import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  pool: { query: vi.fn() },
}))

import { AdminOrdersRepository } from '../../../src/modules/admin/orders/orders.repository.js'
import { ShopOrdersRepository } from '../../../src/modules/shop-orders/repository.js'
import { DeliveryRepository } from '../../../src/modules/delivery/delivery.repository.js'
import { getClient, query } from '../../../src/config/database.js'

const ORDER_ID = '11111111-1111-1111-1111-111111111111'
const ADMIN_ID = '22222222-2222-2222-2222-222222222222'
const ASSIGNMENT_ID = '33333333-3333-3333-3333-333333333333'

function revokeCalls(client) {
  return client.query.mock.calls.filter(([sql]) => sql.includes('order_pickup_tokens') && sql.includes('REVOKED'))
}

describe('QR pickup token revocation on order-terminal transitions', () => {
  let client

  beforeEach(() => {
    vi.clearAllMocks()
    client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }
    getClient.mockResolvedValue(client)
  })

  it('AdminOrdersRepository.updateStatus revokes pickup tokens on CANCELLED', async () => {
    client.query.mockImplementation((sql) => {
      if (sql.includes('SELECT status FROM orders')) return Promise.resolve({ rows: [{ status: 'PACKED' }] })
      return Promise.resolve({ rows: [] })
    })
    const repo = new AdminOrdersRepository()

    await repo.updateStatus(ORDER_ID, 'CANCELLED', ADMIN_ID, 'Customer requested')

    const calls = revokeCalls(client)
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual([ORDER_ID, 'Order CANCELLED'])
  })

  it('AdminOrdersRepository.updateStatus revokes pickup tokens on DELIVERED', async () => {
    client.query.mockImplementation((sql) => {
      if (sql.includes('SELECT status FROM orders')) return Promise.resolve({ rows: [{ status: 'OUT_FOR_DELIVERY' }] })
      return Promise.resolve({ rows: [] })
    })
    const repo = new AdminOrdersRepository()

    await repo.updateStatus(ORDER_ID, 'DELIVERED', ADMIN_ID, null)

    const calls = revokeCalls(client)
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual([ORDER_ID, 'Order DELIVERED'])
  })

  it('AdminOrdersRepository.updateStatus does not touch pickup tokens for a non-terminal transition', async () => {
    client.query.mockImplementation((sql) => {
      if (sql.includes('SELECT status FROM orders')) return Promise.resolve({ rows: [{ status: 'PENDING' }] })
      return Promise.resolve({ rows: [] })
    })
    const repo = new AdminOrdersRepository()

    await repo.updateStatus(ORDER_ID, 'CONFIRMED', ADMIN_ID, null)

    expect(revokeCalls(client)).toHaveLength(0)
  })

  it('ShopOrdersRepository.cancelOpenAssignmentsInTx revokes pickup tokens on shop-staff reassignment', async () => {
    const repo = new ShopOrdersRepository()

    await repo.cancelOpenAssignmentsInTx(client, ORDER_ID)

    const calls = revokeCalls(client)
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual([ORDER_ID, 'Reassigned by shop staff'])
  })

  it('DeliveryRepository.markPickedUp consumes the VERIFIED pickup token for the assignment', async () => {
    client.query.mockImplementation((sql) => {
      if (sql.includes('SELECT status') && sql.includes('FROM orders')) {
        return Promise.resolve({ rows: [{ status: 'PACKED' }] })
      }
      if (sql.includes('UPDATE delivery_assignments') && sql.includes("SET status = 'IN_TRANSIT'")) {
        return Promise.resolve({ rows: [{ id: ASSIGNMENT_ID, rider_id: 'rider-1', order_id: ORDER_ID }] })
      }
      return Promise.resolve({ rows: [] })
    })
    const repo = new DeliveryRepository()

    await repo.markPickedUp(ASSIGNMENT_ID, ORDER_ID)

    const consumeCall = client.query.mock.calls.find(
      ([sql]) => sql.includes('order_pickup_tokens') && sql.includes("SET status = 'CONSUMED'")
    )
    expect(consumeCall).toBeDefined()
    expect(consumeCall[1]).toEqual([ASSIGNMENT_ID])
  })
})
