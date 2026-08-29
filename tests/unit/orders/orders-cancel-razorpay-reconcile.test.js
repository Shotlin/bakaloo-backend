import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Coverage for the "instant cancel bypasses Razorpay reconciliation" bug:
 * the Flutter app calls POST /orders/:id/cancel the moment Razorpay
 * Checkout reports ANY failure (network error, timeout, unknown SDK error —
 * not just a genuine user cancel), often within seconds of order creation.
 * Unlike payment-expiry.worker.js's own 15-minute auto-cancel, this
 * customer-facing cancel endpoint never checked with Razorpay first, so a
 * payment Razorpay had actually captured could get silently orphaned: money
 * taken, order cancelled, no refund — and because the order leaves PENDING
 * status, the worker's own reconciliation query (which only looks at
 * status='PENDING' orders) never revisits it either.
 *
 * cancel() must now mirror the worker's check for unpaid ONLINE orders
 * before honoring the cancel.
 */

const mockClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(async () => mockClient),
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

// _reconcileBeforeCancel no longer calls razorpay.orders.fetchPayments or
// paymentsService.completeVerifiedPayment directly — both were extracted
// into PaymentsService.reconcileWithRazorpay(), shared with
// payment-expiry.worker.js and the admin "re-check with Razorpay" action.
// This module-level mock only needs to satisfy the `if (!razorpay) return
// null` truthiness guard still in orders.service.js; the real
// fetchPayments-then-finalize behavior is exercised in
// payments.service.test.js, not here.
vi.mock('../../../src/config/razorpay.js', () => ({
  razorpay: { orders: { fetchPayments: vi.fn() } },
}))

import { OrdersRepository } from '../../../src/modules/orders/orders.repository.js'
import { OrdersService } from '../../../src/modules/orders/orders.service.js'

const USER_ID = '11111111-1111-1111-1111-111111111111'
const ORDER_ID = '33333333-3333-3333-3333-333333333333'

function makeService({ order, paymentRow, reconcileWithRazorpayResult }) {
  const repository = Object.assign(new OrdersRepository(), {
    findByIdAndUser: vi.fn(async () => order),
    updateStatus: vi.fn(async (id, status, extra) => ({ ...order, status, ...extra })),
  })
  const paymentsRepo = { findByOrderId: vi.fn(async () => paymentRow ?? null) }
  const paymentsService = {
    reconcileWithRazorpay: vi.fn(
      async () => reconcileWithRazorpayResult ?? { captured: false }
    ),
  }
  const shopProductsRepo = { restoreStockForCancelledOrder: vi.fn(async () => {}) }
  const shopProductsService = { invalidateShopCache: vi.fn(async () => {}) }
  const finalizeAssignmentRepo = { cancelOpenAssignment: vi.fn(async () => {}) }
  const cashbackService = { cancelForOrder: vi.fn(async () => {}) }

  const service = new OrdersService(repository, null, {
    paymentsRepository: paymentsRepo,
    paymentsService,
    shopProductsRepository: shopProductsRepo,
    shopProductsService,
    finalizeAssignmentRepository: finalizeAssignmentRepo,
    cashbackService,
  })
  return { service, repository, paymentsRepo, paymentsService }
}

describe('OrdersService.cancel — Razorpay reconciliation guard on unpaid ONLINE orders', () => {
  beforeEach(() => {
    mockClient.query.mockClear()
    mockClient.release.mockClear()
  })

  it('blocks the cancel and confirms the order instead when Razorpay shows the payment was actually captured', async () => {
    const order = {
      id: ORDER_ID,
      userId: USER_ID,
      status: 'PENDING',
      paymentMethod: 'ONLINE',
      paymentStatus: 'PENDING',
      items: [],
    }
    const { service, repository, paymentsService } = makeService({
      order,
      paymentRow: { razorpayOrderId: 'order_rzp_1', status: 'PENDING' },
      reconcileWithRazorpayResult: { captured: true, success: true, payment: {} },
    })
    repository.findByIdAndUser.mockResolvedValueOnce(order).mockResolvedValueOnce({
      ...order,
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    })

    const result = await service.cancel(USER_ID, ORDER_ID, 'Payment cancelled by user')

    expect(paymentsService.reconcileWithRazorpay).toHaveBeenCalledWith(
      'order_rzp_1',
      'ORDER_CANCEL_RECONCILE'
    )
    expect(result.success).toBe(false)
    expect(result.paymentConfirmed).toBe(true)
    expect(result.order.status).toBe('CONFIRMED')
    // The actual cancellation path (stock restore + status=CANCELLED) must
    // never have run.
    expect(repository.updateStatus).not.toHaveBeenCalled()
  })

  it('proceeds with the normal cancel when Razorpay shows no captured payment (genuinely unpaid)', async () => {
    const order = {
      id: ORDER_ID,
      userId: USER_ID,
      status: 'PENDING',
      paymentMethod: 'ONLINE',
      paymentStatus: 'PENDING',
      items: [],
    }
    const { service, repository, paymentsService } = makeService({
      order,
      paymentRow: { razorpayOrderId: 'order_rzp_2', status: 'PENDING' },
      reconcileWithRazorpayResult: { captured: false },
    })

    const result = await service.cancel(USER_ID, ORDER_ID, 'Payment cancelled by user')

    expect(paymentsService.reconcileWithRazorpay).toHaveBeenCalledWith(
      'order_rzp_2',
      'ORDER_CANCEL_RECONCILE'
    )
    expect(result.success).toBe(true)
    expect(repository.updateStatus).toHaveBeenCalledWith(
      ORDER_ID,
      'CANCELLED',
      expect.objectContaining({ cancelledReason: 'Payment cancelled by user' })
    )
  })

  it('refuses to cancel (fails safe) when the Razorpay verification check itself errors out', async () => {
    const order = {
      id: ORDER_ID,
      userId: USER_ID,
      status: 'PENDING',
      paymentMethod: 'ONLINE',
      paymentStatus: 'PENDING',
      items: [],
    }
    const { service, repository, paymentsService } = makeService({
      order,
      paymentRow: { razorpayOrderId: 'order_rzp_3', status: 'PENDING' },
    })
    paymentsService.reconcileWithRazorpay.mockRejectedValue(new Error('Razorpay API timeout'))

    const result = await service.cancel(USER_ID, ORDER_ID, 'Payment cancelled by user')

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/try again/i)
    expect(repository.updateStatus).not.toHaveBeenCalled()
  })

  it('skips the Razorpay check entirely for COD orders (unaffected, existing behavior)', async () => {
    const order = {
      id: ORDER_ID,
      userId: USER_ID,
      status: 'PENDING',
      paymentMethod: 'COD',
      paymentStatus: 'PENDING',
      items: [],
    }
    const { service, repository, paymentsService } = makeService({ order })

    const result = await service.cancel(USER_ID, ORDER_ID, 'Cancelled by customer')

    expect(paymentsService.reconcileWithRazorpay).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(repository.updateStatus).toHaveBeenCalled()
  })

  it('skips the Razorpay check for an ONLINE order that is already PAID (nothing to reconcile)', async () => {
    const order = {
      id: ORDER_ID,
      userId: USER_ID,
      status: 'CONFIRMED',
      paymentMethod: 'ONLINE',
      paymentStatus: 'PAID',
      items: [],
    }
    const { service, repository, paymentsService } = makeService({ order })

    const result = await service.cancel(USER_ID, ORDER_ID, 'Cancelled by customer')

    expect(paymentsService.reconcileWithRazorpay).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(repository.updateStatus).toHaveBeenCalled()
  })
})
