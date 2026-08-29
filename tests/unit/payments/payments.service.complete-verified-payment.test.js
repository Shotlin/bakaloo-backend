import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Coverage for the "resurrected cancelled order" bug found while fixing the
 * Razorpay webhook signature check: orders.service.js's cancel() restores
 * stock the moment its own live Razorpay check comes back empty, but that
 * check can miss a capture that posts a few seconds later. Before this
 * fix, completeVerifiedPayment() never re-checked the order's current
 * status, so a delayed webhook/reconciliation call would silently flip an
 * already-cancelled order back to CONFIRMED and queue a rider to fetch
 * stock that's already back on the shelf (and may already be sold to
 * someone else).
 *
 * completeVerifiedPayment() must now check the order's current status
 * inside the same transaction that locks the payment row, and skip the
 * entire confirm cascade (auto-assign, cashback, cart clear, coupon
 * usage, notification) whenever the order is no longer PENDING —
 * flagging the payment for manual review instead of auto-confirming.
 */

const queuedJobs = []
vi.mock('../../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn(async (name, data, opts) => { queuedJobs.push({ name, data, opts }) }) },
}))

vi.mock('../../../src/config/razorpay.js', () => ({
  razorpay: { orders: { fetchPayments: vi.fn() } },
}))
vi.mock('../../../src/config/env.js', () => ({
  env: { RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'whsecret' },
}))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/modules/orders/orders.repository.js', () => ({
  OrdersRepository: vi.fn().mockImplementation(() => ({
    findByIdAndUser: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn(),
  })),
}))
vi.mock('../../../src/modules/payment-settings/payment-settings.service.js', () => ({
  PaymentSettingsService: vi.fn().mockImplementation(() => ({ getConfig: vi.fn() })),
}))
vi.mock('../../../src/modules/cashback/cashback.service.js', () => ({
  CashbackService: vi.fn().mockImplementation(() => ({
    evaluateAndCredit: vi.fn().mockResolvedValue(undefined),
  })),
}))
// completeVerifiedPayment's success cascade dynamically imports these —
// left unmocked, a prior version of this test relied on their real
// implementations failing fast against the (deliberately minimal)
// database mock, which turned out to be fragile: a change elsewhere made
// one of them hang instead of failing fast, timing out the whole test.
// Mocked explicitly here so the cascade's success path is fully hermetic.
vi.mock('../../../src/modules/cart/cart.repository.js', () => ({
  CartRepository: vi.fn().mockImplementation(() => ({
    clearCart: vi.fn().mockResolvedValue(undefined),
    clearExtras: vi.fn().mockResolvedValue(undefined),
  })),
}))
vi.mock('../../../src/modules/coupons/coupons.repository.js', () => ({
  CouponsRepository: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('../../../src/modules/coupons/coupons.service.js', () => ({
  CouponsService: vi.fn().mockImplementation(() => ({
    recordUsageForOrder: vi.fn().mockResolvedValue(undefined),
  })),
}))
vi.mock('../../../src/modules/notifications/notifications.repository.js', () => ({
  NotificationsRepository: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('../../../src/modules/notifications/notifications.service.js', () => ({
  NotificationsService: vi.fn().mockImplementation(() => ({
    sendNotification: vi.fn().mockResolvedValue(undefined),
  })),
}))
vi.mock('../../../src/modules/notifications/customer-order-event.helper.js', () => ({
  buildCustomerOrderEventNotification: vi.fn().mockReturnValue({}),
}))
vi.mock('../../../src/modules/wallet/wallet.service.js', () => ({
  WalletService: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('../../../src/modules/wallet/wallet.repository.js', () => ({
  WalletRepository: vi.fn().mockImplementation(() => ({})),
}))

const PAYMENT_ID = 'payment-1'
const ORDER_ID = 'order-1'
const RZP_ORDER_ID = 'order_rzp_1'

function makeMockClient({ paymentRow, orderRow }) {
  const calls = []
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql: sql.trim(), params })
    if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
      return {}
    }
    if (sql.includes('FROM payments WHERE razorpay_order_id')) {
      return { rows: paymentRow ? [paymentRow] : [] }
    }
    if (sql.includes('FROM orders WHERE id')) {
      return { rows: orderRow ? [orderRow] : [] }
    }
    if (sql.startsWith('UPDATE payments') || sql.startsWith('UPDATE orders')) {
      return { rows: [] }
    }
    throw new Error(`Unexpected query in test mock: ${sql}`)
  })
  return { client: { query, release: vi.fn() }, calls }
}

async function buildService({ paymentRow, orderRow, formattedPayment }) {
  vi.resetModules()
  const { client, calls } = makeMockClient({ paymentRow, orderRow })
  vi.doMock('../../../src/config/database.js', () => ({
    getClient: vi.fn(async () => client),
    query: vi.fn(),
    pool: {},
  }))

  const { PaymentsService } = await import('../../../src/modules/payments/payments.service.js')
  const repo = {
    findById: vi.fn().mockResolvedValue(formattedPayment ?? { id: PAYMENT_ID, orderId: ORDER_ID, status: 'PAID' }),
  }
  const fastify = { emitDashboardPayment: vi.fn(), emitOrderUpdate: vi.fn() }
  const service = new PaymentsService(repo, fastify)
  return { service, calls, repo, fastify }
}

describe('PaymentsService.completeVerifiedPayment — order-status guard against resurrecting a cancelled order', () => {
  beforeEach(() => {
    queuedJobs.length = 0
  })

  it('confirms normally when the order is still PENDING at the moment of capture', async () => {
    const { service, calls, repo, fastify } = await buildService({
      paymentRow: { id: PAYMENT_ID, order_id: ORDER_ID, user_id: 'user-1', status: 'PENDING' },
      orderRow: { id: ORDER_ID, status: 'PENDING' },
    })

    const result = await service.completeVerifiedPayment(RZP_ORDER_ID, {
      razorpayPaymentId: 'pay_1',
      method: 'upi',
      source: 'PAYMENT_WEBHOOK',
    })

    expect(result.success).toBe(true)
    expect(result.needsManualReview).toBeFalsy()
    // The order row must actually be flipped to CONFIRMED/PAID.
    expect(calls.some((c) => c.sql.startsWith('UPDATE orders') && c.sql.includes("status = 'CONFIRMED'"))).toBe(true)
    // Cascade ran: a rider auto-assign job was actually queued.
    expect(queuedJobs).toHaveLength(1)
    expect(queuedJobs[0].data.orderId).toBe(ORDER_ID)
    expect(repo.findById).toHaveBeenCalledWith(PAYMENT_ID)
    // A routine successful payment doesn't need anyone's attention — the
    // manager-facing "needs review" ping must NOT fire for this path.
    expect(fastify.emitDashboardPayment).not.toHaveBeenCalled()
    expect(fastify.emitOrderUpdate).toHaveBeenCalledWith(
      ORDER_ID,
      ['user-1'],
      expect.objectContaining({ status: 'CONFIRMED' })
    )
  })

  it('flags for manual review — and runs NONE of the confirm cascade — when the order already left PENDING (e.g. cancelled) before the capture arrived', async () => {
    const { service, calls, fastify } = await buildService({
      paymentRow: { id: PAYMENT_ID, order_id: ORDER_ID, user_id: 'user-1', status: 'PENDING', amount: '127.00' },
      orderRow: { id: ORDER_ID, status: 'CANCELLED', order_number: 'GRO-1001' },
    })

    const result = await service.completeVerifiedPayment(RZP_ORDER_ID, {
      razorpayPaymentId: 'pay_1',
      method: 'upi',
      source: 'PAYMENT_WEBHOOK',
    })

    expect(result.success).toBe(true)
    expect(result.needsManualReview).toBe(true)

    // The order's status/fulfillment must NEVER be touched by this path —
    // stock was already restored when it was cancelled; re-confirming it
    // here would double-allocate that stock to a rider.
    expect(calls.some((c) => c.sql.startsWith('UPDATE orders'))).toBe(false)

    // The payment row IS still updated (money is tracked) and flagged —
    // the flag travels as a JSONB parameter, not literal SQL text.
    const paymentUpdate = calls.find((c) => c.sql.startsWith('UPDATE payments'))
    expect(paymentUpdate).toBeTruthy()
    expect(paymentUpdate.sql).toContain("status = 'PAID'")
    const metadataParam = paymentUpdate.params.find((p) => typeof p === 'string' && p.includes('needs_manual_review'))
    expect(metadataParam).toBeTruthy()
    expect(JSON.parse(metadataParam)).toMatchObject({ needs_manual_review: true, reason: 'captured_after_cancel' })

    // None of the confirm cascade (auto-assign, cashback, notification) ran.
    expect(queuedJobs).toHaveLength(0)

    // This IS the one outcome that needs a human — the manager-facing
    // dashboard ping must fire, with enough context to act on without
    // opening the order first.
    expect(fastify.emitDashboardPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER_ID,
        orderNumber: 'GRO-1001',
        orderStatus: 'CANCELLED',
        amount: 127,
      })
    )
  })

  it('is a no-op (skipped) when the payment is already PAID — does not re-run the cascade or re-check order status', async () => {
    const { service, calls } = await buildService({
      paymentRow: { id: PAYMENT_ID, order_id: ORDER_ID, user_id: 'user-1', status: 'PAID' },
      orderRow: { id: ORDER_ID, status: 'CONFIRMED' },
    })

    const result = await service.completeVerifiedPayment(RZP_ORDER_ID, {
      razorpayPaymentId: 'pay_1',
      method: 'upi',
      source: 'PAYMENT_WEBHOOK',
    })

    expect(result.success).toBe(true)
    expect(result.skipped).toBe(true)
    // Never even looked at the orders table — already resolved.
    expect(calls.some((c) => c.sql.includes('FROM orders'))).toBe(false)
    expect(queuedJobs).toHaveLength(0)
  })
})

describe('PaymentsService.completeVerifiedPayment — recovering a payment previously marked FAILED', () => {
  beforeEach(() => {
    queuedJobs.length = 0
  })

  it('leaves a FAILED payment alone when allowRecoveryFromFailed is not passed — the default for every ordinary caller', async () => {
    const { service, calls } = await buildService({
      paymentRow: { id: PAYMENT_ID, order_id: ORDER_ID, user_id: 'user-1', status: 'FAILED' },
      orderRow: { id: ORDER_ID, status: 'PENDING' },
    })

    const result = await service.completeVerifiedPayment(RZP_ORDER_ID, {
      razorpayPaymentId: 'pay_1',
      method: 'upi',
      source: 'PAYMENT_WEBHOOK',
    })

    expect(result.success).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('FAILED')
    // Never even looked at the orders table — bailed out before that.
    expect(calls.some((c) => c.sql.includes('FROM orders'))).toBe(false)
    expect(queuedJobs).toHaveLength(0)
  })

  it('recovers and confirms the order when allowRecoveryFromFailed is true and the order is still PENDING, tagging it recovered_from_failed', async () => {
    const { service, calls, fastify } = await buildService({
      paymentRow: { id: PAYMENT_ID, order_id: ORDER_ID, user_id: 'user-1', status: 'FAILED', amount: '127.00' },
      orderRow: { id: ORDER_ID, status: 'PENDING', order_number: 'GRO-1002' },
    })

    const result = await service.completeVerifiedPayment(RZP_ORDER_ID, {
      razorpayPaymentId: 'pay_1',
      method: 'upi',
      source: 'FAILED_PAYMENT_RECOVERY_SWEEP',
      allowRecoveryFromFailed: true,
    })

    expect(result.success).toBe(true)
    expect(result.needsManualReview).toBeFalsy()
    expect(calls.some((c) => c.sql.startsWith('UPDATE orders') && c.sql.includes("status = 'CONFIRMED'"))).toBe(true)
    expect(queuedJobs).toHaveLength(1)

    // Tagged distinctly so the dashboard's "Recovered" filter and count can
    // find it later — the row's own `status` will read PAID by then, with
    // no other trace of ever having been FAILED unless this is recorded.
    const paymentUpdate = calls.find((c) => c.sql.startsWith('UPDATE payments'))
    expect(paymentUpdate.sql).toContain('recovered_from_failed')

    // This is exactly the "we told the customer it failed and we were
    // wrong" case — worth its own notification even though it auto-healed.
    expect(fastify.emitDashboardPayment).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, recoveredFromFailed: true, amount: 127 })
    )
  })

  it('still flags for manual review (not blind auto-confirm) when a recovered FAILED payment belongs to an order that already moved on', async () => {
    const { service, calls } = await buildService({
      paymentRow: { id: PAYMENT_ID, order_id: ORDER_ID, user_id: 'user-1', status: 'FAILED', amount: '127.00' },
      orderRow: { id: ORDER_ID, status: 'CANCELLED', order_number: 'GRO-1003' },
    })

    const result = await service.completeVerifiedPayment(RZP_ORDER_ID, {
      razorpayPaymentId: 'pay_1',
      method: 'upi',
      source: 'FAILED_PAYMENT_RECOVERY_SWEEP',
      allowRecoveryFromFailed: true,
    })

    expect(result.success).toBe(true)
    expect(result.needsManualReview).toBe(true)
    // The recovery path doesn't bypass the resurrection guard — it's the
    // same finalize function, same protections.
    expect(calls.some((c) => c.sql.startsWith('UPDATE orders'))).toBe(false)
    expect(queuedJobs).toHaveLength(0)
  })
})
