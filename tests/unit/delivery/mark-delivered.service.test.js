import { describe, expect, it, vi, beforeEach } from 'vitest'

// `delivery.service.js` transitively pulls in redis/bullmq/db clients that
// try to connect eagerly — mock all of them so this test needs no live infra.
vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(async () => ({ rows: [] })),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))
vi.mock('../../../src/config/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}))
vi.mock('../../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
  notificationQueue: { add: vi.fn() },
}))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { DeliveryService } = await import('../../../src/modules/delivery/delivery.service.js')

const ORDER_ID = 'order-1'
const ASSIGNMENT_ID = 'assignment-1'
const RIDER_ID = 'rider-1'

function makeAssignmentRow(overrides = {}) {
  return {
    assignment_id: ASSIGNMENT_ID,
    id: ASSIGNMENT_ID,
    order_id: ORDER_ID,
    rider_id: RIDER_ID,
    status: 'IN_TRANSIT',
    payment_method: 'COD',
    total_amount: 250,
    ...overrides,
  }
}

let repo

beforeEach(() => {
  repo = {
    getAssignmentByOrderAndRider: vi.fn(async () => makeAssignmentRow()),
    getOrderAssignmentSnapshot: vi.fn(async () => ({ order_status: 'OUT_FOR_DELIVERY' })),
    verifyDeliveryOtp: vi.fn(async () => true),
    markDelivered: vi.fn(async () => ({ id: ASSIGNMENT_ID, status: 'DELIVERED' })),
    getDeliveryCompletionSummary: vi.fn(async () => ({})),
  }
})

function makeService() {
  return new DeliveryService(repo, null)
}

describe(
  'DeliveryService.markDelivered — COD payment collection (item: rider payment collection)',
  () => {
    it('a COD order whose cash+UPI sum matches the total succeeds and passes normalized amounts through', async () => {
      const service = makeService()

      await service.markDelivered(RIDER_ID, ORDER_ID, '1234', null, false, 150, 100)

      expect(repo.markDelivered).toHaveBeenCalledWith(
        ASSIGNMENT_ID, ORDER_ID, null, expect.any(Boolean), 150, 100
      )
    })

    it('rejects a COD order whose collected total is far off from the order total', async () => {
      const service = makeService()

      await expect(
        service.markDelivered(RIDER_ID, ORDER_ID, '1234', null, false, 50, 50)
      ).rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_AMOUNT_MISMATCH' })

      expect(repo.markDelivered).not.toHaveBeenCalled()
    })

    it('allows a small rounding discrepancy (within ₹2 of the total)', async () => {
      const service = makeService()

      await service.markDelivered(RIDER_ID, ORDER_ID, '1234', null, false, 150, 99)

      expect(repo.markDelivered).toHaveBeenCalledWith(
        ASSIGNMENT_ID, ORDER_ID, null, expect.any(Boolean), 150, 99
      )
    })

    it('ignores collection figures on a non-COD (already-paid) order rather than validating them', async () => {
      repo.getAssignmentByOrderAndRider = vi.fn(async () =>
        makeAssignmentRow({ payment_method: 'WALLET' })
      )
      const service = makeService()

      // Wildly mismatched numbers would fail COD validation, but since this
      // order is already paid via wallet, they must be silently ignored.
      await service.markDelivered(RIDER_ID, ORDER_ID, '1234', null, false, 9999, 9999)

      expect(repo.markDelivered).toHaveBeenCalledWith(
        ASSIGNMENT_ID, ORDER_ID, null, expect.any(Boolean), null, null
      )
    })

    it('a COD delivery with no collection figures at all (e.g. an old client) still succeeds', async () => {
      const service = makeService()

      await service.markDelivered(RIDER_ID, ORDER_ID, '1234', null, false)

      expect(repo.markDelivered).toHaveBeenCalledWith(
        ASSIGNMENT_ID, ORDER_ID, null, expect.any(Boolean), null, null
      )
    })

    it('treats a missing one-sided figure as zero when the other is provided', async () => {
      const service = makeService()

      // Fully cash, no UPI collected at all.
      await service.markDelivered(RIDER_ID, ORDER_ID, '1234', null, false, 250, undefined)

      expect(repo.markDelivered).toHaveBeenCalledWith(
        ASSIGNMENT_ID, ORDER_ID, null, expect.any(Boolean), 250, 0
      )
    })
  }
)
