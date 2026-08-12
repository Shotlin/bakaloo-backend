import { query } from '../../../config/database.js'
import { HOME_STATE_CODE, normalizeStateToGstCode, formatPlaceOfSupply } from '../../../utils/gstStateCodes.js'

// GST rule: an interstate (different-state) B2C invoice whose taxable value
// exceeds this threshold must be reported individually under B2CL, not
// folded into the B2CS state+rate consolidation. B2CL itself isn't built
// this round — matching orders are excluded from B2CS and returned
// separately so nothing is silently dropped from the totals.
const B2CL_THRESHOLD = 100000

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

export class Gstr1Repository {
  /**
   * B2CS (7): state+rate-wise consolidated summary of DELIVERED orders in
   * the period, grouped by (Place of Supply, tax rate actually charged).
   *
   * The rate is read from orders.fee_breakdown.fees[] (the real rate
   * TotalsEngine charged this order — code:'GST', metadata.rate), NOT from
   * any product field, so this ties out exactly to orders.tax_amount.
   */
  async getB2CSSummary({ startDate, endDate }) {
    const { rows } = await query(
      `SELECT o.id, o.order_number, o.total_amount, o.tax_amount, o.tip_amount,
              o.delivery_address->>'state' AS raw_state,
              (SELECT elem->'metadata'->>'rate'
                 FROM jsonb_array_elements(COALESCE(o.fee_breakdown->'fees', '[]'::jsonb)) elem
                WHERE elem->>'code' = 'GST'
                LIMIT 1) AS charged_rate
       FROM orders o
       WHERE o.status = 'DELIVERED'
         AND o.created_at >= $1
         AND o.created_at <= $2`,
      [startDate, endDate]
    )

    const groups = new Map() // key: `${placeOfSupply}|${rate}` -> { placeOfSupply, rate, taxableValue }
    const excludedB2CL = []

    for (const row of rows) {
      const rate = round2(row.charged_rate || 0)
      const taxableValue = round2(
        Number(row.total_amount) - Number(row.tax_amount || 0) - Number(row.tip_amount || 0)
      )
      const { code, name, matched } = normalizeStateToGstCode(row.raw_state)
      const placeOfSupply = formatPlaceOfSupply(code, name)
      // Unmatched/unknown state can't be confirmed interstate — never
      // auto-exclude those into B2CL, an admin needs to fix the address
      // data first. Only a *matched*, genuinely different state counts.
      const isInterstate = matched && code !== HOME_STATE_CODE

      if (isInterstate && taxableValue > B2CL_THRESHOLD) {
        excludedB2CL.push({
          orderId: row.id,
          orderNumber: row.order_number,
          taxableValue,
          placeOfSupply,
        })
        continue
      }

      const key = `${placeOfSupply}|${rate}`
      const existing = groups.get(key)
      if (existing) {
        existing.taxableValue = round2(existing.taxableValue + taxableValue)
      } else {
        groups.set(key, { placeOfSupply, rate, taxableValue })
      }
    }

    return {
      rows: Array.from(groups.values()).sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.rate - b.rate),
      excludedB2CL,
    }
  }

  /**
   * HSN Summary (12): product/HSN-wise summary of order_items on DELIVERED
   * orders in the period, grouped by (HSN, UQC, rate).
   *
   * This is a NOTIONAL per-item allocation using each item's own effective
   * rate (its own snapshot, else the product's current rate, else the
   * global default) — there is no per-item tax at checkout today, so this
   * total will generally NOT equal B2CS / orders.tax_amount. See the
   * migration 099 column comments and gstr1.service.js's export footnote.
   */
  async getHsnSummary({ startDate, endDate }) {
    const { rows } = await query(
      `SELECT oi.id, oi.total AS taxable_value, oi.quantity, oi.name AS item_name,
              oi.hsn_code_snapshot, oi.gst_rate_snapshot,
              p.hsn_code AS product_hsn_code, p.uqc AS product_uqc, p.gst_rate AS product_gst_rate,
              o.delivery_address->>'state' AS raw_state,
              fs.gst_rate AS global_gst_rate
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
       LEFT JOIN fee_settings fs ON fs.scope = 'GLOBAL'
       WHERE o.status = 'DELIVERED'
         AND o.created_at >= $1
         AND o.created_at <= $2`,
      [startDate, endDate]
    )

    const groups = new Map() // key: `${hsn}|${uqc}|${rate}`

    for (const row of rows) {
      const hsn = row.hsn_code_snapshot || row.product_hsn_code || 'UNKNOWN'
      const uqc = row.product_uqc || 'OTH'
      const rate = round2(
        row.gst_rate_snapshot ?? row.product_gst_rate ?? row.global_gst_rate ?? 0
      )
      const taxableValue = round2(row.taxable_value)
      const quantity = Number(row.quantity) || 0

      const { code, matched } = normalizeStateToGstCode(row.raw_state)
      // Unknown delivery state defaults to intrastate (CGST+SGST) — the
      // overwhelming majority of Bakaloo's orders are same-state, and this
      // avoids silently misclassifying every order with incomplete address
      // data as interstate (IGST).
      const isInterstate = matched && code !== HOME_STATE_CODE

      const taxAmount = round2(taxableValue * (rate / 100))
      const cgst = isInterstate ? 0 : round2(taxAmount / 2)
      const sgst = isInterstate ? 0 : round2(taxAmount / 2)
      const igst = isInterstate ? taxAmount : 0

      const totalValue = round2(taxableValue + taxAmount)

      const key = `${hsn}|${uqc}|${rate}`
      const existing = groups.get(key)
      if (existing) {
        existing.quantity += quantity
        existing.taxableValue = round2(existing.taxableValue + taxableValue)
        existing.totalValue = round2(existing.totalValue + totalValue)
        existing.cgst = round2(existing.cgst + cgst)
        existing.sgst = round2(existing.sgst + sgst)
        existing.igst = round2(existing.igst + igst)
      } else {
        groups.set(key, {
          hsn,
          description: row.item_name || hsn,
          uqc,
          quantity,
          rate,
          taxableValue,
          totalValue,
          cgst,
          sgst,
          igst,
        })
      }
    }

    return Array.from(groups.values()).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
  }
}
