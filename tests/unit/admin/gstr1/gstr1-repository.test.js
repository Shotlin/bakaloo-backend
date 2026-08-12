import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/config/database.js', () => ({
  query: vi.fn(),
}))

import { Gstr1Repository } from '../../../../src/modules/admin/gstr1/gstr1.repository.js'
import { query } from '../../../../src/config/database.js'

describe('Gstr1Repository.getB2CSSummary', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new Gstr1Repository()
  })

  it('groups intrastate orders by (place of supply, rate), summing taxable value', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: '1', order_number: 'BKLOO-1', total_amount: 1050, tax_amount: 50, tip_amount: 0, raw_state: 'Gujarat', charged_rate: '5' },
        { id: '2', order_number: 'BKLOO-2', total_amount: 2100, tax_amount: 100, tip_amount: 0, raw_state: '24', charged_rate: '5' },
      ],
    })

    const result = await repo.getB2CSSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(result.excludedB2CL).toEqual([])
    expect(result.rows).toEqual([
      { placeOfSupply: '24-Gujarat', rate: 5, taxableValue: 3000 }, // (1050-50) + (2100-100)
    ])
  })

  it('excludes an interstate order over the ₹1,00,000 B2CL threshold', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: '1', order_number: 'BKLOO-1', total_amount: 150000, tax_amount: 0, tip_amount: 0, raw_state: 'West Bengal', charged_rate: '0' },
      ],
    })

    const result = await repo.getB2CSSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(result.rows).toEqual([])
    expect(result.excludedB2CL).toEqual([
      { orderId: '1', orderNumber: 'BKLOO-1', taxableValue: 150000, placeOfSupply: '19-West Bengal' },
    ])
  })

  it('does NOT exclude an intrastate order over the threshold (B2CL only applies to interstate)', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: '1', order_number: 'BKLOO-1', total_amount: 150000, tax_amount: 0, tip_amount: 0, raw_state: 'Gujarat', charged_rate: '0' },
      ],
    })

    const result = await repo.getB2CSSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(result.excludedB2CL).toEqual([])
    expect(result.rows).toEqual([{ placeOfSupply: '24-Gujarat', rate: 0, taxableValue: 150000 }])
  })

  it('never auto-excludes an unmatched/unknown state, even above the threshold', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: '1', order_number: 'BKLOO-1', total_amount: 150000, tax_amount: 0, tip_amount: 0, raw_state: 'Narnia', charged_rate: '0' },
      ],
    })

    const result = await repo.getB2CSSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(result.excludedB2CL).toEqual([])
    expect(result.rows).toEqual([{ placeOfSupply: 'Narnia', rate: 0, taxableValue: 150000 }])
  })

  it('excludes tip_amount and tax_amount from the taxable value', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: '1', order_number: 'BKLOO-1', total_amount: 1200, tax_amount: 50, tip_amount: 30, raw_state: 'Gujarat', charged_rate: '5' },
      ],
    })

    const result = await repo.getB2CSSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(result.rows).toEqual([{ placeOfSupply: '24-Gujarat', rate: 5, taxableValue: 1120 }]) // 1200-50-30
  })
})

describe('Gstr1Repository.getHsnSummary', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new Gstr1Repository()
  })

  it('prefers the order_item snapshot over the product and global rate', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '1', taxable_value: 100, quantity: 2, item_name: 'Milk',
          hsn_code_snapshot: '0401', gst_rate_snapshot: '5',
          product_hsn_code: '9999', product_uqc: 'NOS', product_gst_rate: '18',
          raw_state: 'Gujarat', global_gst_rate: '18',
        },
      ],
    })

    const [row] = await repo.getHsnSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(row.hsn).toBe('0401')
    expect(row.rate).toBe(5)
    expect(row.taxableValue).toBe(100)
    expect(row.cgst).toBe(2.5)
    expect(row.sgst).toBe(2.5)
    expect(row.igst).toBe(0)
  })

  it('falls back to the product HSN/rate when there is no snapshot (legacy row)', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '1', taxable_value: 200, quantity: 1, item_name: 'Rice',
          hsn_code_snapshot: null, gst_rate_snapshot: null,
          product_hsn_code: '1006', product_uqc: 'KGS', product_gst_rate: '5',
          raw_state: 'Gujarat', global_gst_rate: '18',
        },
      ],
    })

    const [row] = await repo.getHsnSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(row.hsn).toBe('1006')
    expect(row.uqc).toBe('KGS')
    expect(row.rate).toBe(5)
  })

  it('falls back to UNKNOWN/global rate when neither snapshot nor product data exist', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '1', taxable_value: 50, quantity: 1, item_name: 'Mystery Item',
          hsn_code_snapshot: null, gst_rate_snapshot: null,
          product_hsn_code: null, product_uqc: null, product_gst_rate: null,
          raw_state: 'Gujarat', global_gst_rate: '18',
        },
      ],
    })

    const [row] = await repo.getHsnSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(row.hsn).toBe('UNKNOWN')
    expect(row.uqc).toBe('OTH')
    expect(row.rate).toBe(18)
  })

  it('splits tax as IGST (not CGST/SGST) for an interstate order', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '1', taxable_value: 100, quantity: 1, item_name: 'Milk',
          hsn_code_snapshot: '0401', gst_rate_snapshot: '5',
          product_hsn_code: null, product_uqc: 'NOS', product_gst_rate: null,
          raw_state: 'Maharashtra', global_gst_rate: '18',
        },
      ],
    })

    const [row] = await repo.getHsnSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(row.igst).toBe(5)
    expect(row.cgst).toBe(0)
    expect(row.sgst).toBe(0)
  })

  it('groups multiple items with the same (hsn, uqc, rate) and sums quantity/values', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '1', taxable_value: 100, quantity: 2, item_name: 'Milk 500ml',
          hsn_code_snapshot: '0401', gst_rate_snapshot: '5',
          product_hsn_code: null, product_uqc: 'NOS', product_gst_rate: null,
          raw_state: 'Gujarat', global_gst_rate: '18',
        },
        {
          id: '2', taxable_value: 50, quantity: 1, item_name: 'Milk 1L',
          hsn_code_snapshot: '0401', gst_rate_snapshot: '5',
          product_hsn_code: null, product_uqc: 'NOS', product_gst_rate: null,
          raw_state: 'Gujarat', global_gst_rate: '18',
        },
      ],
    })

    const rows = await repo.getHsnSummary({ startDate: '2026-04-01', endDate: '2026-04-30' })

    expect(rows).toHaveLength(1)
    expect(rows[0].quantity).toBe(3)
    expect(rows[0].taxableValue).toBe(150)
  })
})
