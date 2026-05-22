import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveryService } from './delivery.service.js'

function createRepositoryMock() {
  return {
    getAssignmentByOrderAndRider: vi.fn(),
    getOrderAssignmentSnapshot: vi.fn(),
    acceptOrder: vi.fn(),
    rejectOrder: vi.fn(),
    markPickedUp: vi.fn(),
    markDelivered: vi.fn(),
    verifyDeliveryOtp: vi.fn(),
    storeDeliveryOtp: vi.fn(),
    saveProofPhoto: vi.fn(),
    getAssignedOrders: vi.fn(),
    getStoreSettings: vi.fn(),
    getDeliveryStats: vi.fn(),
    getDeliveryEarnings: vi.fn(),
    getDeliveryPayouts: vi.fn(),
    getDeliveryCompletionSummary: vi.fn(),
    updateLocation: vi.fn(),
    getDeliveryHistory: vi.fn(),
  }
}

function createService(repository) {
  const service = new DeliveryService(repository, {})
  service._emitOrderUpdate = vi.fn()
  service._emitOrderExpired = vi.fn()
  service._queueNotification = vi.fn()
  service._queueAutoAssign = vi.fn()
  service._runAutoAssignFallback = vi.fn()
  service._queueBacklogAssignScan = vi.fn()
  return service
}

describe('DeliveryService assignment identifier fallback', () => {
  let repository
  let service

  beforeEach(() => {
    repository = createRepositoryMock()
    service = createService(repository)
  })

  it('accepts an order when assignment only exposes id', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      id: 'assignment-1',
      status: 'ASSIGNED',
      customer_id: 'customer-1',
      order_number: 'ORD-1',
    })
    repository.acceptOrder.mockResolvedValue({
      conflict: false,
      assignment: { id: 'assignment-1', status: 'ACCEPTED' },
      cancelledOffers: [],
    })
    repository.storeDeliveryOtp.mockResolvedValue(undefined)

    await service.acceptOrder('rider-1', 'order-1')

    expect(repository.acceptOrder).toHaveBeenCalledWith(
      'assignment-1',
      'order-1',
      'rider-1'
    )
    expect(repository.storeDeliveryOtp).toHaveBeenCalledWith(
      'order-1',
      expect.any(String)
    )
  })

  it('rejects an order when assignment only exposes id', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      id: 'assignment-2',
      status: 'ASSIGNED',
      customer_id: 'customer-1',
      order_number: 'ORD-2',
    })
    repository.rejectOrder.mockResolvedValue({
      assignment: { id: 'assignment-2', status: 'CANCELLED' },
      shouldReassign: false,
    })

    await service.rejectOrder('rider-1', 'order-2', 'OTHER')

    expect(repository.rejectOrder).toHaveBeenCalledWith(
      'assignment-2',
      'order-2',
      'OTHER'
    )
  })

  it('marks picked up when assignment only exposes id', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      id: 'assignment-3',
      status: 'ACCEPTED',
      customer_id: 'customer-1',
      order_number: 'ORD-3',
    })
    repository.markPickedUp.mockResolvedValue({ status: 'IN_TRANSIT' })

    await service.markPickedUp('rider-1', 'order-3')

    expect(repository.markPickedUp).toHaveBeenCalledWith(
      'assignment-3',
      'order-3'
    )
  })

  it('treats repeated pickup as idempotent when snapshot is already in transit', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(null)
    repository.getOrderAssignmentSnapshot.mockResolvedValue({
      assignment_id: 'assignment-3b',
      assignment_status: 'IN_TRANSIT',
      order_status: 'OUT_FOR_DELIVERY',
      rider_id: 'rider-1',
    })

    const result = await service.markPickedUp('rider-1', 'order-3b')

    expect(result).toEqual({
      id: 'assignment-3b',
      status: 'IN_TRANSIT',
      alreadyPickedUp: true,
    })
    expect(repository.markPickedUp).not.toHaveBeenCalled()
  })

  it('marks delivered when assignment only exposes id', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      id: 'assignment-4',
      status: 'IN_TRANSIT',
      customer_id: 'customer-1',
      order_number: 'ORD-4',
    })
    repository.markDelivered.mockResolvedValue({ status: 'DELIVERED' })
    repository.getDeliveryCompletionSummary.mockResolvedValue({
      orderId: 'order-4',
      orderNumber: 'ORD-4',
      customerName: 'Customer',
      earnedAmount: 25,
      baseFee: 25,
      distanceBonus: 0,
      performanceBonus: 0,
      tipAmount: 0,
      totalToday: 25,
    })

    const result = await service.markDelivered('rider-1', 'order-4', '', 'proof-url')

    expect(repository.markDelivered).toHaveBeenCalledWith(
      'assignment-4',
      'order-4',
      'proof-url'
    )
    expect(repository.getDeliveryCompletionSummary).toHaveBeenCalledWith(
      'order-4',
      'rider-1'
    )
    expect(result.completionSummary).toEqual({
      orderId: 'order-4',
      orderNumber: 'ORD-4',
      customerName: 'Customer',
      earnedAmount: 25,
      baseFee: 25,
      distanceBonus: 0,
      performanceBonus: 0,
      tipAmount: 0,
      totalToday: 25,
    })
  })

  it('allows demo delivery without otp or proof outside production', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      id: 'assignment-5',
      status: 'IN_TRANSIT',
      customer_id: 'customer-1',
      order_number: 'ORD-5',
    })
    repository.markDelivered.mockResolvedValue({
      status: 'DELIVERED',
      completionSummary: {
        orderId: 'order-5',
        orderNumber: 'ORD-5',
        customerName: 'Customer',
        earnedAmount: 25,
        baseFee: 25,
        distanceBonus: 0,
        performanceBonus: 0,
        tipAmount: 0,
        totalToday: 25,
      },
    })

    await service.markDelivered('rider-1', 'order-5', '', '', true)

    expect(repository.verifyDeliveryOtp).not.toHaveBeenCalled()
    expect(repository.markDelivered).toHaveBeenCalledWith(
      'assignment-5',
      'order-5',
      null
    )
  })

  it('treats repeated delivery as idempotent when snapshot is already delivered', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(null)
    repository.getOrderAssignmentSnapshot.mockResolvedValue({
      assignment_id: 'assignment-5b',
      assignment_status: 'DELIVERED',
      order_status: 'DELIVERED',
      rider_id: 'rider-1',
    })
    repository.getDeliveryCompletionSummary.mockResolvedValue({
      orderId: 'order-5b',
      orderNumber: 'ORD-5B',
      customerName: 'Customer',
      earnedAmount: 25,
      baseFee: 25,
      distanceBonus: 0,
      performanceBonus: 0,
      tipAmount: 0,
      totalToday: 25,
    })

    const result = await service.markDelivered('rider-1', 'order-5b', '', '', true)

    expect(result).toEqual({
      id: 'assignment-5b',
      status: 'DELIVERED',
      alreadyDelivered: true,
      completionSummary: {
        orderId: 'order-5b',
        orderNumber: 'ORD-5B',
        customerName: 'Customer',
        earnedAmount: 25,
        baseFee: 25,
        distanceBonus: 0,
        performanceBonus: 0,
        tipAmount: 0,
        totalToday: 25,
      },
    })
    expect(repository.markDelivered).not.toHaveBeenCalled()
  })

  it('prefers assignment_id when both identifiers are present', async () => {
    expect(
      service._resolveAssignmentId({
        id: 'assignment-row-id',
        assignment_id: 'assignment-alias-id',
      })
    ).toBe('assignment-alias-id')
  })
})
