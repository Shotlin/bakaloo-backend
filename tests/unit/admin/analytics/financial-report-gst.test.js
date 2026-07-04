import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/config/database.js', () => ({
  query: vi.fn(),
}))

import { AdminAnalyticsRepository } from '../../../../src/modules/admin/analytics/analytics.repository.js'
import { query } from '../../../../src/config/database.js'

function mockFinancialReportQueries({ grossTaxable, gstRateValue }) {
  query
    .mockResolvedValueOnce({
      rows: [{ gross_revenue: 1000, total_discounts: 0, delivery_fees: 50, net_revenue: 1000, order_count: 10 }],
    }) // rev summary
    .mockResolvedValueOnce({ rows: [] }) // byPayment
    .mockResolvedValueOnce({ rows: [{ gross_taxable: grossTaxable }] }) // grossRow
    .mockResolvedValueOnce({ rows: [gstRateValue === undefined ? undefined : { value: gstRateValue }] }) // gstSetting
}

describe('AdminAnalyticsRepository.getFinancialReport — GST breakdown', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new AdminAnalyticsRepository()
  })

  it('backs out GST from GST-inclusive order totals using the configured rate', async () => {
    // 5% rate on a gross (inclusive) taxable amount of 1050 -> tax = 50, net = 1000
    mockFinancialReportQueries({ grossTaxable: 1050, gstRateValue: '5' })

    const result = await repo.getFinancialReport({})

    expect(result.gstBreakdown).toEqual([
      { gst_rate: 5, taxable_amount: 1000, gst_amount: 50 },
    ])
  })

  it('reports an explicit 0% row when no gst_rate setting exists — honest about being unconfigured rather than silently hiding the card', async () => {
    mockFinancialReportQueries({ grossTaxable: 1050, gstRateValue: undefined })

    const result = await repo.getFinancialReport({})

    expect(result.gstBreakdown).toEqual([
      { gst_rate: 0, taxable_amount: 1050, gst_amount: 0 },
    ])
  })

  it('returns an empty breakdown when there is no taxable revenue in the period', async () => {
    mockFinancialReportQueries({ grossTaxable: 0, gstRateValue: '5' })

    const result = await repo.getFinancialReport({})

    expect(result.gstBreakdown).toEqual([])
  })

  it('rounds gst_amount/taxable_amount to 2 decimal places for a non-round rate', async () => {
    // 18% on 100 (inclusive) -> gst = 100*18/118 = 15.254237... -> rounds to 15.25
    mockFinancialReportQueries({ grossTaxable: 100, gstRateValue: '18' })

    const result = await repo.getFinancialReport({})

    expect(result.gstBreakdown).toEqual([
      { gst_rate: 18, taxable_amount: 84.75, gst_amount: 15.25 },
    ])
  })
})
