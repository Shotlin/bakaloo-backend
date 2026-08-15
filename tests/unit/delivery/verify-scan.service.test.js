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
const { signPickupPayload, QR_TOKEN_VERSION } = await import('../../../src/utils/qrToken.js')

const ORDER_ID = 'order-1'
const ASSIGNMENT_ID = 'assignment-1'
const TOKEN_ID = 'token-row-1'
const RAW_TOKEN = 'raw-token-value'
const RIDER_ID = 'rider-1'
const OTHER_RIDER_ID = 'rider-2'

// The QR itself carries no order/assignment id (see qrToken.js) — only
// {token, version, signature}. Which order it belongs to is discovered by
// looking the token up against order_pickup_tokens.
function makePayload(overrides = {}) {
  const base = { token: RAW_TOKEN, v: QR_TOKEN_VERSION }
  const withOverrides = { ...base, ...overrides }
  const sig = overrides.sig ?? signPickupPayload({
    token: withOverrides.token, version: withOverrides.v,
  })
  return { ...withOverrides, sig }
}

function makeTokenRow(overrides = {}) {
  return {
    id: TOKEN_ID, order_id: ORDER_ID, delivery_assignment_id: ASSIGNMENT_ID,
    token: RAW_TOKEN, version: QR_TOKEN_VERSION, status: 'ACTIVE', expires_at: null,
    ...overrides,
  }
}

function makeAssignmentRow(overrides = {}) {
  return { id: ASSIGNMENT_ID, order_id: ORDER_ID, rider_id: RIDER_ID, status: 'ACCEPTED', ...overrides }
}

let repo

beforeEach(() => {
  repo = {
    findPickupTokenByValue: vi.fn(async () => makeTokenRow()),
    findVerifiedTokenForOrderAndRider: vi.fn(async () => makeTokenRow({ status: 'VERIFIED' })),
    expireTokenIfPast: vi.fn(async () => false),
    getAssignmentById: vi.fn(async () => makeAssignmentRow()),
    getOrderAssignmentSnapshot: vi.fn(async () => ({ order_status: 'PACKED' })),
    claimPickupTokenAsVerified: vi.fn(async () => true),
    logScanAttempt: vi.fn(async () => {}),
    getPickupChecklist: vi.fn(async () => ({
      order: {
        order_number: 'ORD-1', customer_name: 'Jane', customer_phone: '9000000000',
        delivery_address: { lat: 12.9, lng: 77.6, addressLine1: 'Test' },
        delivery_notes: null, delivery_instructions: 'Leave at gate',
      },
      items: [{ name: 'Milk', quantity: 2, unit: 'L', thumbnail_url: 'http://img', net_quantity: '1 L', option_label: null }],
    })),
  }
})

function makeService() {
  return new DeliveryService(repo, null)
}

describe('DeliveryService.verifyScan', () => {
  it('accepts a valid scan, claims the token, and returns a price-free checklist with the resolved order id', async () => {
    const service = makeService()
    const result = await service.verifyScan(RIDER_ID, makePayload(), { ip: '1.2.3.4' })

    expect(repo.claimPickupTokenAsVerified).toHaveBeenCalledWith(TOKEN_ID, RIDER_ID)
    expect(repo.logScanAttempt).toHaveBeenCalledWith(expect.objectContaining({ result: 'SUCCESS', tokenId: TOKEN_ID, orderId: ORDER_ID }))
    expect(result.orderId).toBe(ORDER_ID)
    expect(result.orderNumber).toBe('ORD-1')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toEqual({ name: 'Milk', quantity: 2, unit: 'L', image: 'http://img', variant: '1 L' })

    // No financial field appears anywhere in the response, by construction.
    const serialized = JSON.stringify(result).toLowerCase()
    for (const forbidden of ['price', 'subtotal', 'tax', 'discount', 'commission', 'revenue', 'amount']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('rejects a payload missing a token before any DB lookup', async () => {
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, { v: QR_TOKEN_VERSION, sig: 'x' })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    })
    expect(repo.findPickupTokenByValue).not.toHaveBeenCalled()
  })

  it('rejects a tampered signature before any DB lookup', async () => {
    const service = makeService()
    const badPayload = makePayload({ sig: 'not-a-real-signature' })

    await expect(service.verifyScan(RIDER_ID, badPayload)).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    })
    expect(repo.findPickupTokenByValue).not.toHaveBeenCalled()
    // orderId is never learned for a rejection this early — the QR itself
    // carries no order reference, only the token does.
    expect(repo.logScanAttempt).toHaveBeenCalledWith(expect.objectContaining({ result: 'REJECTED', failureReason: 'INVALID_SIGNATURE', orderId: null }))
  })

  it('rejects and flips status when the token is past its expiry', async () => {
    repo.expireTokenIfPast.mockResolvedValue(true)
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, makePayload())).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    })
    expect(repo.expireTokenIfPast).toHaveBeenCalledWith(TOKEN_ID)
    expect(repo.claimPickupTokenAsVerified).not.toHaveBeenCalled()
  })

  it('rejects with the exact spec-mandated message when the order belongs to a different rider', async () => {
    repo.getAssignmentById.mockResolvedValue(makeAssignmentRow({ rider_id: OTHER_RIDER_ID }))
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, makePayload())).rejects.toMatchObject({
      code: 'WRONG_RIDER',
      message: 'This order is not assigned to your rider account.',
    })
    // Once the token is found, the resolved orderId is known and logged
    // even on a subsequent rejection.
    expect(repo.logScanAttempt).toHaveBeenCalledWith(expect.objectContaining({ result: 'REJECTED', failureReason: 'WRONG_RIDER', orderId: ORDER_ID }))
  })

  it('rejects when no assignment exists for this token at all', async () => {
    repo.getAssignmentById.mockResolvedValue(null)
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, makePayload())).rejects.toMatchObject({
      code: 'WRONG_RIDER',
    })
  })

  it('loses a concurrent double-scan race cleanly (only one caller ever claims the token)', async () => {
    repo.claimPickupTokenAsVerified.mockResolvedValue(false)
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, makePayload())).rejects.toMatchObject({
      code: 'ALREADY_VERIFIED',
    })
  })

  it('rejects a token that has already been revoked', async () => {
    repo.findPickupTokenByValue.mockResolvedValue(makeTokenRow({ status: 'REVOKED' }))
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, makePayload())).rejects.toMatchObject({
      code: 'TOKEN_REVOKED',
    })
  })

  it('rejects a token already consumed by a completed pickup', async () => {
    repo.findPickupTokenByValue.mockResolvedValue(makeTokenRow({ status: 'CONSUMED' }))
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, makePayload())).rejects.toMatchObject({
      code: 'ALREADY_PICKED_UP',
    })
  })

  it('rejects when the order itself is already cancelled', async () => {
    repo.getOrderAssignmentSnapshot.mockResolvedValue({ order_status: 'CANCELLED' })
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, makePayload())).rejects.toMatchObject({
      code: 'ORDER_ALREADY_CANCELLED',
    })
  })

  it('rejects an unrecognized token value', async () => {
    repo.findPickupTokenByValue.mockResolvedValue(null)
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, makePayload())).rejects.toMatchObject({
      code: 'TOKEN_NOT_FOUND',
    })
  })

  it('logs every rejection to qr_scan_logs with rider context even on failure', async () => {
    repo.findPickupTokenByValue.mockResolvedValue(null)
    const service = makeService()

    await expect(service.verifyScan(RIDER_ID, makePayload())).rejects.toBeTruthy()

    expect(repo.logScanAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ riderId: RIDER_ID, result: 'REJECTED' })
    )
  })
})

describe('DeliveryService.getPendingChecklist', () => {
  it('returns the checklist for an order this rider already scanned (VERIFIED, not yet consumed)', async () => {
    const service = makeService()
    const result = await service.getPendingChecklist(RIDER_ID, ORDER_ID)

    expect(repo.findVerifiedTokenForOrderAndRider).toHaveBeenCalledWith(ORDER_ID, RIDER_ID)
    expect(result.orderId).toBe(ORDER_ID)
    expect(result.orderNumber).toBe('ORD-1')
    expect(result.items).toHaveLength(1)

    // Same price-free guarantee as verify-scan's response.
    const serialized = JSON.stringify(result).toLowerCase()
    for (const forbidden of ['price', 'subtotal', 'tax', 'discount', 'commission', 'revenue', 'amount']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('rejects when there is no VERIFIED token for this order/rider pair', async () => {
    repo.findVerifiedTokenForOrderAndRider.mockResolvedValue(null)
    const service = makeService()

    await expect(service.getPendingChecklist(RIDER_ID, ORDER_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NO_PENDING_CHECKLIST',
    })
  })

  it('never returns another rider\'s pending checklist (scoped in the query, not just by convention)', async () => {
    repo.findVerifiedTokenForOrderAndRider.mockResolvedValue(null)
    const service = makeService()

    await expect(service.getPendingChecklist(OTHER_RIDER_ID, ORDER_ID)).rejects.toMatchObject({
      code: 'NO_PENDING_CHECKLIST',
    })
    expect(repo.findVerifiedTokenForOrderAndRider).toHaveBeenCalledWith(ORDER_ID, OTHER_RIDER_ID)
  })
})
