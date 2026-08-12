import ExcelJS from 'exceljs'
import { Gstr1Repository } from './gstr1.repository.js'
import { getGstr1Period, getGstr1PeriodRange } from '../../../utils/gstr1DueDate.js'

const repo = new Gstr1Repository()

/** Resolves either a structured period or raw dates to { startDate, endDate }. */
function resolveRange(params) {
  if (params.periodType && params.year) {
    return getGstr1PeriodRange(params)
  }
  return { startDate: params.startDate, endDate: params.endDate }
}

export class Gstr1Service {
  /** GET /period — pure date math, no DB. */
  getPeriod(params) {
    return getGstr1Period(params)
  }

  async getB2CS(params) {
    const range = resolveRange(params)
    return repo.getB2CSSummary(range)
  }

  async getHsnSummary(params) {
    const range = resolveRange(params)
    return repo.getHsnSummary(range)
  }

  async exportExcel(params) {
    const range = resolveRange(params)
    const [{ rows: b2csRows, excludedB2CL }, hsnRows] = await Promise.all([
      repo.getB2CSSummary(range),
      repo.getHsnSummary(range),
    ])

    const workbook = new ExcelJS.Workbook()

    const b2csSheet = workbook.addWorksheet('B2CS')
    b2csSheet.addRow(['Summary For B2CS(7)'])
    b2csSheet.addRow([
      '', '', '', '',
      'Total Taxable Value', 'Total Cess', '',
    ])
    b2csSheet.addRow([
      '', '', '', '',
      Number(b2csRows.reduce((sum, r) => sum + r.taxableValue, 0).toFixed(2)),
      0, '',
    ])
    b2csSheet.addRow([]) // blank separator row, matches the reference template
    b2csSheet.addRow([
      'Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate',
      'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN',
    ])
    for (const r of b2csRows) {
      b2csSheet.addRow(['', r.placeOfSupply, '', r.rate, r.taxableValue, 0, ''])
    }
    b2csSheet.columns.forEach((col) => { col.width = 22 })

    if (excludedB2CL.length > 0) {
      b2csSheet.addRow([])
      b2csSheet.addRow([
        `${excludedB2CL.length} interstate order(s) over ₹1,00,000 excluded — file these individually under GSTR-1 Table 5 (B2CL):`,
      ])
      b2csSheet.addRow(['Order Number', 'Place Of Supply', 'Taxable Value'])
      for (const r of excludedB2CL) {
        b2csSheet.addRow([r.orderNumber, r.placeOfSupply, r.taxableValue])
      }
    }

    const hsnSheet = workbook.addWorksheet('HSN')
    hsnSheet.addRow(['Summary For HSN(12)'])
    hsnSheet.addRow([
      '', '', '', '', 'Total Value', '', 'Total Taxable Value',
      'Total Integrated Tax', 'Total Central Tax', 'Total State/UT Tax', 'Total Cess',
    ])
    hsnSheet.addRow([
      '', '', '', '',
      Number(hsnRows.reduce((sum, r) => sum + r.totalValue, 0).toFixed(2)), '',
      Number(hsnRows.reduce((sum, r) => sum + r.taxableValue, 0).toFixed(2)),
      Number(hsnRows.reduce((sum, r) => sum + r.igst, 0).toFixed(2)),
      Number(hsnRows.reduce((sum, r) => sum + r.cgst, 0).toFixed(2)),
      Number(hsnRows.reduce((sum, r) => sum + r.sgst, 0).toFixed(2)),
      0,
    ])
    hsnSheet.addRow([])
    hsnSheet.addRow([
      'HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate',
      'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount',
    ])
    for (const r of hsnRows) {
      hsnSheet.addRow([
        r.hsn, r.description, r.uqc, r.quantity, r.totalValue, r.rate,
        r.taxableValue, r.igst, r.cgst, r.sgst, 0,
      ])
    }
    hsnSheet.columns.forEach((col) => { col.width = 18 })
    hsnSheet.addRow([])
    hsnSheet.addRow([
      'Note: HSN Summary tax amounts are computed per product\'s configured GST rate ' +
      'and may not equal the GST actually collected (see B2CS / orders.tax_amount), ' +
      'which is charged as one flat rate per order at checkout.',
    ])

    return workbook.xlsx.writeBuffer()
  }
}
