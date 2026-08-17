import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'

// Header aliases recognized as the "customer number" column — covers both
// our own downloadable template ("Customer Number") and the general
// customer export a shop admin might reuse instead ("Phone").
const PHONE_HEADER_ALIASES = new Set([
  'customernumber', 'number', 'phone', 'phonenumber',
  'mobilenumber', 'mobile', 'customerphone', 'contactnumber',
])

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s_-]/g, '')
}

/** Indian mobile numbers only: 10 digits, starting 6-9. Strips +91/91/0 prefixes and formatting. */
function normalizePhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  return /^[6-9]\d{9}$/.test(digits) ? digits : null
}

function cellToString(v) {
  if (v == null) return ''
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString()
    if ('result' in v) return String(v.result ?? '')
    if ('text' in v) return String(v.text ?? '')
    if ('richText' in v) return v.richText.map((r) => r.text).join('')
    return ''
  }
  return String(v)
}

async function parseCsvBuffer(buffer) {
  return new Promise((resolve, reject) => {
    parse(buffer, { columns: true, skip_empty_lines: true, trim: true }, (err, data) => {
      if (err) return reject(err)
      resolve(data)
    })
  })
}

async function parseXlsxBuffer(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const ws = wb.worksheets[0]
  if (!ws) return []

  const headerValues = ws.getRow(1).values
  const headers = Array.isArray(headerValues)
    ? headerValues.slice(1).map((h) => cellToString(h).trim())
    : []

  const rows = []
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const values = Array.isArray(row.values) ? row.values.slice(1) : []
    const record = {}
    headers.forEach((h, i) => { record[h] = values[i] })
    if (Object.values(record).some((v) => cellToString(v).trim())) rows.push(record)
  })
  return rows
}

/**
 * Parses an uploaded segment-member-import file (.xlsx/.csv) into a
 * deduped list of normalized phone numbers. Matching is by number only —
 * a "name" column, if present, is for the uploader's reference and never
 * used to identify who gets added (names collide, numbers don't).
 */
export async function parseSegmentImportFile(buffer, filename = '') {
  const ext = filename.toLowerCase().split('.').pop()
  const records = ext === 'csv' ? await parseCsvBuffer(buffer) : await parseXlsxBuffer(buffer)

  if (records.length === 0) {
    return { phones: [], totalRows: 0, unmatchedRows: 0 }
  }

  const headerKeys = Object.keys(records[0])
  const phoneKey = headerKeys.find((k) => PHONE_HEADER_ALIASES.has(normalizeHeader(k)))

  const phones = []
  let unmatchedRows = 0
  for (const row of records) {
    const raw = phoneKey ? row[phoneKey] : Object.values(row)[0]
    const normalized = normalizePhone(cellToString(raw))
    if (normalized) {
      phones.push(normalized)
    } else if (cellToString(raw).trim()) {
      unmatchedRows++
    }
  }

  return { phones: [...new Set(phones)], totalRows: records.length, unmatchedRows }
}
