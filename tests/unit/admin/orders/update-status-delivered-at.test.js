import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

import { AdminOrdersRepository } from '../../../../src/modules/admin/orders/orders.repository.js'
import { getClient } from '../../../../src/config/database.js'

const ORDER_ID = '11111111-1111-1111-1111-111111111111'
const ADMIN_ID = '22222222-2222-2222-2222-222222222222'

function mockOrderRow(client, row) {
  client.query.mockImplementation((sql) => {
    if (sql.includes('FROM orders') && sql.includes('FOR UPDATE')) {
      return Promise.resolve({ rows: [row] })
    }
    return Promise.resolve({ rows: [] })
  })
}

describe('AdminOrdersRepository.updateStatus — delivered_at', () => {
  let client
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    client = { query: vi.fn(), release: vi.fn() }
    getClient.mockResolvedValue(client)
    repo = new AdminOrdersRepository()
  })

  it('sets delivered_at when transitioning to DELIVERED — the settlement worker filters on it and previously never found these orders', async () => {
    mockOrderRow(client, { status: 'OUT_FOR_DELIVERY', payment_method: 'ONLINE', payment_status: 'PAID' })

    await repo.updateStatus(ORDER_ID, 'DELIVERED', ADMIN_ID, 'Marked delivered')

    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE orders SET status')
    )
    expect(updateCall[0]).toContain('delivered_at = COALESCE(delivered_at, NOW())')
    expect(updateCall[1]).toEqual(['DELIVERED', ORDER_ID, false])
  })

  it('does not touch delivered_at for non-DELIVERED transitions', async () => {
    mockOrderRow(client, { status: 'PENDING', payment_method: 'COD', payment_status: 'PENDING' })

    await repo.updateStatus(ORDER_ID, 'CONFIRMED', ADMIN_ID, null)

    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE orders SET status')
    )
    expect(updateCall[0]).not.toContain('delivered_at')
    expect(updateCall[1]).toEqual(['CONFIRMED', ORDER_ID])
  })

  it('does not overwrite an already-set delivered_at (idempotent re-transition)', async () => {
    mockOrderRow(client, { status: 'DELIVERED', payment_method: 'ONLINE', payment_status: 'PAID' })

    await repo.updateStatus(ORDER_ID, 'DELIVERED', ADMIN_ID, null)

    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE orders SET status')
    )
    // COALESCE(delivered_at, NOW()) preserves any existing timestamp
    expect(updateCall[0]).toContain('COALESCE(delivered_at, NOW())')
  })
})

describe('AdminOrdersRepository.updateStatus — COD payment_status on manual DELIVERED', () => {
  let client
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    client = { query: vi.fn(), release: vi.fn() }
    getClient.mockResolvedValue(client)
    repo = new AdminOrdersRepository()
  })

  it('marks a COD order PAID when an admin manually transitions it to DELIVERED — cash was collected at the door, same assumption refundOrder/cancelOrder already make', async () => {
    mockOrderRow(client, { status: 'OUT_FOR_DELIVERY', payment_method: 'COD', payment_status: 'PENDING' })

    await repo.updateStatus(ORDER_ID, 'DELIVERED', ADMIN_ID, null)

    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE orders SET status')
    )
    expect(updateCall[0]).toContain("payment_status = CASE WHEN $3 THEN 'PAID' ELSE payment_status END")
    expect(updateCall[1]).toEqual(['DELIVERED', ORDER_ID, true])
  })

  it('does not re-flag an already-PAID COD order (idempotent)', async () => {
    mockOrderRow(client, { status: 'OUT_FOR_DELIVERY', payment_method: 'COD', payment_status: 'PAID' })

    await repo.updateStatus(ORDER_ID, 'DELIVERED', ADMIN_ID, null)

    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE orders SET status')
    )
    expect(updateCall[1]).toEqual(['DELIVERED', ORDER_ID, false])
  })

  it('never auto-marks an ONLINE order PAID just because it reached DELIVERED — an online order genuinely stuck PENDING (e.g. a failed/abandoned payment) must stay that way for the admin to investigate', async () => {
    mockOrderRow(client, { status: 'OUT_FOR_DELIVERY', payment_method: 'ONLINE', payment_status: 'PENDING' })

    await repo.updateStatus(ORDER_ID, 'DELIVERED', ADMIN_ID, null)

    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE orders SET status')
    )
    expect(updateCall[1]).toEqual(['DELIVERED', ORDER_ID, false])
  })
})
