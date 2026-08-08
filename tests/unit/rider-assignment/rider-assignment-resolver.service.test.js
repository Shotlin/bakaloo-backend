import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const ORDER_ID = 'order-1'
const SHOP_ID = 'shop-1'
const USER_ID = 'user-1'
const ADDRESS_ID = 'addr-1'

function makeOrderRow(overrides = {}) {
  return {
    id: ORDER_ID,
    user_id: USER_ID,
    shop_id: SHOP_ID,
    rider_id: null,
    status: 'PACKED',
    assignment_method: null,
    delivery_address: { id: ADDRESS_ID },
    delivery_fee: 25,
    ...overrides,
  }
}

// `_loadOrder` / `_loadShopCoords` query the DB directly — every other
// query used by tier 2/3 goes through the mocked RiderAssignmentRepository
// below, so this mock only ever needs to answer those two lookups.
const queryMock = vi.fn(async (sql) => {
  if (sql.includes('FROM shops')) {
    return { rows: [{ lat: '12.9', lng: '77.6' }] }
  }
  if (sql.includes('FROM orders')) {
    return { rows: [makeOrderRow()] }
  }
  return { rows: [] }
})

vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
}))

let mockAssignmentRepo
let mockFinalizeRepo
let finalizeMock

vi.mock('../../../src/modules/rider-assignment/rider-assignment.repository.js', () => ({
  RiderAssignmentRepository: vi.fn().mockImplementation(() => mockAssignmentRepo),
}))

vi.mock('../../../src/modules/rider-assignment/finalize-assignment.repository.js', () => ({
  FinalizeAssignmentRepository: vi.fn().mockImplementation(() => mockFinalizeRepo),
}))

vi.mock('../../../src/modules/rider-assignment/finalize-assignment.service.js', () => ({
  FinalizeAssignmentService: vi.fn().mockImplementation(() => ({ finalize: finalizeMock })),
}))

const { RiderAssignmentResolverService } = await import(
  '../../../src/modules/rider-assignment/rider-assignment-resolver.service.js'
)

beforeEach(() => {
  vi.clearAllMocks()
  queryMock.mockImplementation(async (sql) => {
    if (sql.includes('FROM shops')) return { rows: [{ lat: '12.9', lng: '77.6' }] }
    if (sql.includes('FROM orders')) return { rows: [makeOrderRow()] }
    return { rows: [] }
  })
  finalizeMock = vi.fn(async ({ riderId, method }) => ({ success: true, riderId, method, assignmentId: 'a1' }))
  mockAssignmentRepo = {
    findMatchingSegments: vi.fn(async () => []),
    getGlobalDefaultCapacity: vi.fn(async () => 4),
    getRiderCapacityStatus: vi.fn(async () => ({ capacity: 4, active_count: 0 })),
    getEligibleAutoCandidates: vi.fn(async () => []),
    logDecision: vi.fn(async () => {}),
  }
  mockFinalizeRepo = { setManualRequired: vi.fn(async () => {}) }
})

function makeFastify() {
  return { emitAutoAssignmentFailed: vi.fn() }
}

describe('RiderAssignmentResolverService.resolveAndFinalize', () => {
  it('tier 1: a manual pick always wins, even with a matching segment available', async () => {
    mockAssignmentRepo.findMatchingSegments.mockResolvedValue([
      { id: 'seg-1', name: 'Zone A', rider_id: 'rider-segment', priority: 10, created_at: new Date() },
    ])
    const resolver = new RiderAssignmentResolverService(makeFastify())

    const result = await resolver.resolveAndFinalize(ORDER_ID, { manualRiderId: 'rider-manual', actorAdminId: 'admin-1' })

    expect(result.success).toBe(true)
    expect(finalizeMock).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ riderId: 'rider-manual', method: 'MANUAL' }))
    expect(mockAssignmentRepo.findMatchingSegments).not.toHaveBeenCalled()
  })

  it('refuses to auto-overwrite an order that already carries a MANUAL assignment', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('FROM orders')) return { rows: [makeOrderRow({ assignment_method: 'MANUAL', rider_id: 'rider-x' })] }
      return { rows: [] }
    })
    const resolver = new RiderAssignmentResolverService(makeFastify())

    const result = await resolver.resolveAndFinalize(ORDER_ID, {})

    expect(result).toEqual({ success: false, reason: 'MANUAL_ASSIGNMENT_PROTECTED' })
    expect(finalizeMock).not.toHaveBeenCalled()
  })

  it('tier 2: assigns the exact area-segment match for this customer + address', async () => {
    mockAssignmentRepo.findMatchingSegments.mockResolvedValue([
      { id: 'seg-1', name: 'Zone A', rider_id: 'rider-segment', priority: 5, created_at: new Date() },
    ])
    const resolver = new RiderAssignmentResolverService(makeFastify())

    const result = await resolver.resolveAndFinalize(ORDER_ID, {})

    expect(result.success).toBe(true)
    expect(finalizeMock).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({ riderId: 'rider-segment', method: 'AREA_SEGMENT', areaSegmentId: 'seg-1' })
    )
  })

  it('tier 2 conflict: two active segments matching the same address resolve deterministically and get logged', async () => {
    mockAssignmentRepo.findMatchingSegments.mockResolvedValue([
      { id: 'seg-high-priority', name: 'Zone High', rider_id: 'rider-a', priority: 10, created_at: new Date('2026-01-01') },
      { id: 'seg-low-priority', name: 'Zone Low', rider_id: 'rider-b', priority: 1, created_at: new Date('2025-01-01') },
    ])
    const resolver = new RiderAssignmentResolverService(makeFastify())

    await resolver.resolveAndFinalize(ORDER_ID, {})

    // Repository already orders by priority DESC, created_at ASC — the
    // resolver must take matches[0] as-is and log that a conflict occurred.
    expect(finalizeMock).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({ riderId: 'rider-a', method: 'AREA_SEGMENT', areaSegmentId: 'seg-high-priority', reason: expect.stringContaining('conflict') })
    )
  })

  it('tier 2 falls through to tier 3 when the segment rider is at capacity', async () => {
    mockAssignmentRepo.findMatchingSegments.mockResolvedValue([
      { id: 'seg-1', name: 'Zone A', rider_id: 'rider-segment', priority: 5, created_at: new Date() },
    ])
    mockAssignmentRepo.getRiderCapacityStatus.mockResolvedValue({ capacity: 4, active_count: 4 })
    mockAssignmentRepo.getEligibleAutoCandidates.mockResolvedValue([
      { rider_id: 'rider-auto', current_lat: '12.9', current_lng: '77.6', last_assigned_at: null, active_count: 0, capacity: 4 },
    ])
    const resolver = new RiderAssignmentResolverService(makeFastify())

    await resolver.resolveAndFinalize(ORDER_ID, {})

    expect(finalizeMock).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ riderId: 'rider-auto', method: 'AUTO' }))
    // The skipped segment decision is still logged (never silent).
    expect(mockAssignmentRepo.logDecision).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'AREA_SEGMENT', reason: expect.stringContaining('capacity') })
    )
  })

  it('tier 3: picks the rider with the lowest workload first', async () => {
    mockAssignmentRepo.getEligibleAutoCandidates.mockResolvedValue([
      { rider_id: 'rider-busy', current_lat: '12.9', current_lng: '77.6', last_assigned_at: null, active_count: 3, capacity: 4 },
      { rider_id: 'rider-free', current_lat: '12.9', current_lng: '77.6', last_assigned_at: null, active_count: 0, capacity: 4 },
    ])
    const resolver = new RiderAssignmentResolverService(makeFastify())

    await resolver.resolveAndFinalize(ORDER_ID, {})

    expect(finalizeMock).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ riderId: 'rider-free', method: 'AUTO' }))
  })

  it('tier 3: breaks equal workload by distance to the pickup store', async () => {
    mockAssignmentRepo.getEligibleAutoCandidates.mockResolvedValue([
      { rider_id: 'rider-far', current_lat: '13.5', current_lng: '78.5', last_assigned_at: null, active_count: 1, capacity: 4 },
      { rider_id: 'rider-near', current_lat: '12.91', current_lng: '77.61', last_assigned_at: null, active_count: 1, capacity: 4 },
    ])
    const resolver = new RiderAssignmentResolverService(makeFastify())

    await resolver.resolveAndFinalize(ORDER_ID, {})

    expect(finalizeMock).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ riderId: 'rider-near', method: 'AUTO' }))
  })

  it('tier 3: breaks equal workload+distance ties by fairness (oldest last_assigned_at wins)', async () => {
    mockAssignmentRepo.getEligibleAutoCandidates.mockResolvedValue([
      { rider_id: 'rider-recent', current_lat: '12.9', current_lng: '77.6', last_assigned_at: new Date('2026-08-06T10:00:00Z'), active_count: 1, capacity: 4 },
      { rider_id: 'rider-stale', current_lat: '12.9', current_lng: '77.6', last_assigned_at: new Date('2026-08-01T10:00:00Z'), active_count: 1, capacity: 4 },
    ])
    const resolver = new RiderAssignmentResolverService(makeFastify())

    await resolver.resolveAndFinalize(ORDER_ID, {})

    expect(finalizeMock).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ riderId: 'rider-stale', method: 'AUTO' }))
  })

  it('looks up segment matches by this order\'s exact customer + saved-address id, never by address text', async () => {
    const resolver = new RiderAssignmentResolverService(makeFastify())

    await resolver.resolveAndFinalize(ORDER_ID, {})

    // Item 12/17: matching must be (user_id, address_id) exact — a
    // different address for the same customer, or a similar address for a
    // different customer, must never match. That guarantee lives in the
    // repository's SQL WHERE clause; this asserts the resolver feeds it
    // the order's own user_id and the address id embedded in
    // delivery_address, not anything derived from address text.
    expect(mockAssignmentRepo.findMatchingSegments).toHaveBeenCalledWith(USER_ID, ADDRESS_ID)
  })

  it('skips the segment lookup entirely when the order has no resolvable address id', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('FROM orders')) return { rows: [makeOrderRow({ delivery_address: {} })] }
      return { rows: [] }
    })
    const resolver = new RiderAssignmentResolverService(makeFastify())

    await resolver.resolveAndFinalize(ORDER_ID, {})

    expect(mockAssignmentRepo.findMatchingSegments).not.toHaveBeenCalled()
  })

  it('flags the order for manual assignment when no rider is eligible', async () => {
    mockAssignmentRepo.getEligibleAutoCandidates.mockResolvedValue([])
    const fastify = makeFastify()
    const resolver = new RiderAssignmentResolverService(fastify)

    const result = await resolver.resolveAndFinalize(ORDER_ID, {})

    expect(result).toEqual({ success: false, reason: 'NO_ELIGIBLE_RIDER' })
    expect(mockFinalizeRepo.setManualRequired).toHaveBeenCalledWith(ORDER_ID)
    expect(fastify.emitAutoAssignmentFailed).toHaveBeenCalledWith(expect.objectContaining({ order_id: ORDER_ID, reason: 'NO_ELIGIBLE_RIDER' }))
    expect(finalizeMock).not.toHaveBeenCalled()
  })
})
