import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/utils/pushNotification.js', () => ({
  sendPush: vi.fn(async () => ({})),
}))

const mockClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }

const ORDER_ID = 'order-1'
const NEW_RIDER_ID = 'rider-new'
const OLD_RIDER_ID = 'rider-old'
const ASSIGNMENT_ID = 'assignment-1'

function makeOrderRow(overrides = {}) {
  return {
    id: ORDER_ID,
    user_id: 'user-1',
    shop_id: 'shop-1',
    rider_id: OLD_RIDER_ID,
    status: 'PACKED',
    assignment_method: 'AUTO',
    delivery_address: { id: 'addr-1' },
    delivery_fee: 25,
    order_number: 'ORD-1',
    ...overrides,
  }
}

let mockRepo
let mockCommissionRepo
let mockAssignmentLogRepo

vi.mock('../../../src/modules/rider-assignment/finalize-assignment.repository.js', () => ({
  FinalizeAssignmentRepository: vi.fn().mockImplementation(() => mockRepo),
}))

vi.mock('../../../src/modules/rider-assignment/rider-assignment.repository.js', () => ({
  RiderAssignmentRepository: vi.fn().mockImplementation(() => mockAssignmentLogRepo),
}))

vi.mock('../../../src/modules/commission-settings/commission-settings.repository.js', () => ({
  CommissionSettingsRepository: vi.fn().mockImplementation(() => mockCommissionRepo),
}))

const { FinalizeAssignmentService } = await import(
  '../../../src/modules/rider-assignment/finalize-assignment.service.js'
)

function makeFastify() {
  return {
    emitOrderAssignedToRider: vi.fn(),
    emitOrderExpiredToRider: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockClient.query.mockReset().mockResolvedValue({ rows: [] })

  mockRepo = {
    getClient: vi.fn(async () => mockClient),
    lockOrder: vi.fn(async () => makeOrderRow()),
    cancelOpenAssignment: vi.fn(async () => [{ id: 'old-assignment', rider_id: OLD_RIDER_ID }]),
    revokeActiveTokens: vi.fn(async () => {}),
    insertAssignment: vi.fn(async (_client, orderId, riderId, earnings) => ({
      id: ASSIGNMENT_ID, order_id: orderId, rider_id: riderId, status: 'ASSIGNED', earnings,
    })),
    updateOrderAssignment: vi.fn(async () => {}),
    mintToken: vi.fn(async () => ({ id: 'token-1', token: 'tok', version: 1 })),
    updateLastAssignedAt: vi.fn(async () => {}),
    claimNotificationSlot: vi.fn(async () => true),
    getRiderFcmTokens: vi.fn(async () => ['fcm-token-1']),
    setManualRequired: vi.fn(async () => {}),
  }
  mockCommissionRepo = { isCommissionEnabled: vi.fn(async () => true) }
  mockAssignmentLogRepo = { logDecision: vi.fn(async () => {}), getAssignmentHistory: vi.fn(async () => []) }
})

describe('FinalizeAssignmentService.finalize', () => {
  it('cancels the previous rider, mints a fresh token, and notifies only the new rider', async () => {
    const fastify = makeFastify()
    const service = new FinalizeAssignmentService(fastify)

    const result = await service.finalize(ORDER_ID, {
      riderId: NEW_RIDER_ID, method: 'AUTO', reason: 'test', triggeredBy: 'SYSTEM',
    })

    expect(result.success).toBe(true)
    expect(mockRepo.cancelOpenAssignment).toHaveBeenCalledWith(mockClient, ORDER_ID, expect.stringContaining('AUTO'))
    expect(mockRepo.revokeActiveTokens).toHaveBeenCalled()
    expect(mockRepo.insertAssignment).toHaveBeenCalledWith(mockClient, ORDER_ID, NEW_RIDER_ID, expect.any(Number))
    expect(mockRepo.mintToken).toHaveBeenCalled()
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')

    // Only the new rider gets a socket event + push.
    expect(fastify.emitOrderAssignedToRider).toHaveBeenCalledWith(NEW_RIDER_ID, expect.objectContaining({ orderId: ORDER_ID }))
    expect(fastify.emitOrderAssignedToRider).not.toHaveBeenCalledWith(OLD_RIDER_ID, expect.anything())

    // The previous rider only gets the "expired/removed" socket event, no push.
    expect(fastify.emitOrderExpiredToRider).toHaveBeenCalledWith(OLD_RIDER_ID, expect.objectContaining({ orderId: ORDER_ID }))
  })

  it('never overwrites a MANUAL assignment with an AUTO/AREA_SEGMENT resolve', async () => {
    mockRepo.lockOrder.mockResolvedValue(makeOrderRow({ assignment_method: 'MANUAL' }))
    const service = new FinalizeAssignmentService(makeFastify())

    const result = await service.finalize(ORDER_ID, { riderId: NEW_RIDER_ID, method: 'AUTO' })

    expect(result).toEqual({ success: false, reason: 'MANUAL_ASSIGNMENT_PROTECTED' })
    expect(mockRepo.insertAssignment).not.toHaveBeenCalled()
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('allows MANUAL to override an existing MANUAL assignment (admin re-picks)', async () => {
    mockRepo.lockOrder.mockResolvedValue(makeOrderRow({ assignment_method: 'MANUAL' }))
    const service = new FinalizeAssignmentService(makeFastify())

    const result = await service.finalize(ORDER_ID, { riderId: NEW_RIDER_ID, method: 'MANUAL' })

    expect(result.success).toBe(true)
    expect(mockRepo.insertAssignment).toHaveBeenCalled()
  })

  it('is a no-op when re-resolved to the same rider already on the order', async () => {
    mockRepo.lockOrder.mockResolvedValue(makeOrderRow({ rider_id: NEW_RIDER_ID }))
    const service = new FinalizeAssignmentService(makeFastify())

    const result = await service.finalize(ORDER_ID, { riderId: NEW_RIDER_ID, method: 'AUTO' })

    expect(result).toEqual({ success: true, unchanged: true, riderId: NEW_RIDER_ID })
    expect(mockRepo.cancelOpenAssignment).not.toHaveBeenCalled()
    expect(mockRepo.insertAssignment).not.toHaveBeenCalled()
  })

  it('seeds zero earnings when rider commission is disabled', async () => {
    mockCommissionRepo.isCommissionEnabled.mockResolvedValue(false)
    const service = new FinalizeAssignmentService(makeFastify())

    await service.finalize(ORDER_ID, { riderId: NEW_RIDER_ID, method: 'AUTO' })

    expect(mockRepo.insertAssignment).toHaveBeenCalledWith(mockClient, ORDER_ID, NEW_RIDER_ID, 0)
  })

  it('does not double-push when the notification slot was already claimed (dedup)', async () => {
    mockRepo.claimNotificationSlot.mockResolvedValue(false)
    const fastify = makeFastify()
    const service = new FinalizeAssignmentService(fastify)

    await service.finalize(ORDER_ID, { riderId: NEW_RIDER_ID, method: 'AUTO' })

    expect(fastify.emitOrderAssignedToRider).not.toHaveBeenCalled()
    expect(mockRepo.getRiderFcmTokens).not.toHaveBeenCalled()
  })

  it('logs the assignment decision after a successful finalize', async () => {
    const service = new FinalizeAssignmentService(makeFastify())

    await service.finalize(ORDER_ID, { riderId: NEW_RIDER_ID, method: 'AREA_SEGMENT', reason: 'matched segment', triggeredBy: 'SYSTEM' })

    expect(mockAssignmentLogRepo.logDecision).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, riderId: NEW_RIDER_ID, method: 'AREA_SEGMENT' })
    )
  })

  it('rolls back and returns ORDER_NOT_FOUND when the order does not exist', async () => {
    mockRepo.lockOrder.mockResolvedValue(null)
    const service = new FinalizeAssignmentService(makeFastify())

    const result = await service.finalize('missing-order', { riderId: NEW_RIDER_ID, method: 'AUTO' })

    expect(result).toEqual({ success: false, reason: 'ORDER_NOT_FOUND' })
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it.each(['CANCELLED', 'DELIVERED', 'REFUNDED'])(
    'rolls back and returns ORDER_NOT_ACTIVE for a %s order (never hands a rider a dead order)',
    async (status) => {
      mockRepo.lockOrder.mockResolvedValue(makeOrderRow({ status }))
      const service = new FinalizeAssignmentService(makeFastify())

      const result = await service.finalize(ORDER_ID, { riderId: NEW_RIDER_ID, method: 'AUTO' })

      expect(result).toEqual({ success: false, reason: 'ORDER_NOT_ACTIVE' })
      expect(mockRepo.insertAssignment).not.toHaveBeenCalled()
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
    }
  )
})
