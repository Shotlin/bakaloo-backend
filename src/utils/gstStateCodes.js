/**
 * GST (CBIC) state/UT code table + normalization for GSTR-1 "Place of
 * Supply" grouping. Pure, no DB/network.
 *
 * HOME_STATE_CODE is Bakaloo's own filing GSTIN's state (see
 * src/config/storeInfo.js — 24ABFFB1171P1ZD = Gujarat). Used by the B2CS
 * repository to tell intrastate (CGST+SGST) from interstate (IGST) supplies
 * and to flag the B2CL threshold.
 */

export const HOME_STATE_CODE = '24' // Gujarat — from STORE_INFO.gstNo

export const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh (New)',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
}

// Common alternate spellings/legacy names that show up in address data.
const STATE_NAME_ALIASES = {
  ORISSA: 'Odisha',
  PONDICHERRY: 'Puducherry',
  'NCT OF DELHI': 'Delhi',
  'NEW DELHI': 'Delhi',
  UTTARANCHAL: 'Uttarakhand',
  'DAMAN AND DIU': 'Dadra and Nagar Haveli and Daman and Diu',
  'DADRA AND NAGAR HAVELI': 'Dadra and Nagar Haveli and Daman and Diu',
}

const NAME_TO_CODE = Object.fromEntries(
  Object.entries(GST_STATE_CODES).map(([code, name]) => [name.toUpperCase(), code])
)

/**
 * Resolve a raw state string (code or name, from delivery_address JSONB)
 * to a GST state code + canonical name.
 *
 * @returns {{ code: string|null, name: string, matched: boolean }}
 */
export function normalizeStateToGstCode(rawState) {
  if (!rawState || typeof rawState !== 'string') {
    return { code: null, name: 'Unknown', matched: false }
  }
  const trimmed = rawState.trim()
  if (!trimmed) return { code: null, name: 'Unknown', matched: false }

  // Already a 2-digit code?
  if (/^\d{1,2}$/.test(trimmed)) {
    const code = trimmed.padStart(2, '0')
    const name = GST_STATE_CODES[code]
    if (name) return { code, name, matched: true }
  }

  const upper = trimmed.toUpperCase()
  const aliased = STATE_NAME_ALIASES[upper] || null
  const canonicalName = aliased || (NAME_TO_CODE[upper] ? GST_STATE_CODES[NAME_TO_CODE[upper]] : null)
  const code = canonicalName ? NAME_TO_CODE[canonicalName.toUpperCase()] : null

  if (code && canonicalName) {
    return { code, name: canonicalName, matched: true }
  }

  return { code: null, name: trimmed, matched: false }
}

/** Formats as the reference GSTR-1 template expects, e.g. "24-Gujarat". */
export function formatPlaceOfSupply(code, name) {
  if (!code) return name || 'Unknown'
  return `${code}-${name}`
}
