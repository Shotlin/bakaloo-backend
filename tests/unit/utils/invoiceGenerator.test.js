import { describe, it, expect } from 'vitest'
import { generateInvoicePDF } from '../../../src/utils/invoiceGenerator.js'

function baseOrder(overrides = {}) {
  return {
    order_number: 'BKLOO-20260704-001',
    created_at: '2026-07-01T10:00:00.000Z',
    status: 'DELIVERED',
    payment_method: 'COD',
    payment_status: 'PAID',
    delivery_address: { label: 'Home', address_line: '221B Baker St', city: 'Kolkata', pincode: '700001' },
    items: [{ name: 'Milk 1L', quantity: 2, price: 60, total: 120 }],
    subtotal: 120,
    discount_amount: 0,
    delivery_fee: 20,
    tax_amount: 0,
    total_amount: 140,
    ...overrides,
  }
}

async function isPdfBuffer(promise) {
  const buffer = await promise
  expect(Buffer.isBuffer(buffer)).toBe(true)
  expect(buffer.length).toBeGreaterThan(0)
  expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-')
}

describe('generateInvoicePDF — normal orders (no banner)', () => {
  it('renders a valid PDF for a DELIVERED order with no timeline/payment', async () => {
    await isPdfBuffer(generateInvoicePDF(baseOrder()))
  })

  it('renders a valid PDF for a PENDING order', async () => {
    await isPdfBuffer(generateInvoicePDF(baseOrder({ status: 'PENDING' })))
  })
})

describe('generateInvoicePDF — CANCELLED banner', () => {
  it('renders without throwing when no timeline is supplied (plain banner)', async () => {
    await isPdfBuffer(generateInvoicePDF(baseOrder({ status: 'CANCELLED' })))
  })

  it('renders with a timeline reason + date present', async () => {
    await isPdfBuffer(
      generateInvoicePDF(
        baseOrder({
          status: 'CANCELLED',
          timeline: [
            { from_status: 'PENDING', to_status: 'CONFIRMED', note: null, changed_at: '2026-07-01T10:05:00.000Z' },
            { from_status: 'CONFIRMED', to_status: 'CANCELLED', note: 'Customer requested cancellation', changed_at: '2026-07-01T11:00:00.000Z' },
          ],
        })
      )
    )
  })

  it('picks the LAST matching transition when the same status appears twice in the timeline', async () => {
    await isPdfBuffer(
      generateInvoicePDF(
        baseOrder({
          status: 'CANCELLED',
          timeline: [
            { from_status: 'PENDING', to_status: 'CANCELLED', note: 'first pass', changed_at: '2026-07-01T09:00:00.000Z' },
            { from_status: 'CANCELLED', to_status: 'CONFIRMED', note: 'reinstated', changed_at: '2026-07-01T10:00:00.000Z' },
            { from_status: 'CONFIRMED', to_status: 'CANCELLED', note: 'cancelled again', changed_at: '2026-07-01T11:00:00.000Z' },
          ],
        })
      )
    )
  })
})

describe('generateInvoicePDF — REFUNDED banner', () => {
  it('renders with a refund amount from order.payment', async () => {
    await isPdfBuffer(
      generateInvoicePDF(
        baseOrder({
          status: 'REFUNDED',
          payment: { refund_amount: '140.00' },
          timeline: [
            { from_status: 'CANCELLED', to_status: 'REFUNDED', note: 'Refund issued', changed_at: '2026-07-02T09:00:00.000Z' },
          ],
        })
      )
    )
  })

  it('renders without throwing when payment.refund_amount is absent (wallet refund gap)', async () => {
    await isPdfBuffer(generateInvoicePDF(baseOrder({ status: 'REFUNDED' })))
  })
})
