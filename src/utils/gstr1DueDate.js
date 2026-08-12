/**
 * GSTR-1 period range + statutory due-date math. Pure functions, no DB/
 * network — reused by the /admin/gstr1/period endpoint and internally
 * whenever a controller receives structured period params instead of raw
 * startDate/endDate.
 *
 * Indian financial year runs April -> March. Quarters (QRMP scheme):
 *   Q1 = Apr-Jun, Q2 = Jul-Sep, Q3 = Oct-Dec, Q4 = Jan-Mar (of year+1)
 * `year` for QUARTER periods is always the FY START year (e.g. 2025 means
 * FY2025-26), regardless of which quarter — so Q4's calendar months fall
 * in `year + 1`.
 *
 * Due dates (current GST rule, not fetched from anywhere — these are
 * statutory and effectively fixed):
 *   Monthly filers:   11th of the following calendar month.
 *   QRMP (quarterly):  13th of the month after the quarter ends.
 */

function pad2(n) {
  return String(n).padStart(2, '0')
}

function toDateString(year, month, day) {
  // month is 1-12. Constructed via Date.UTC so this is never off by a day
  // from a local-timezone offset.
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function lastDayOfMonth(year, month) {
  // Date.UTC(year, month, 0) is the last day of the given 1-12 `month`.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Roll a 1-12 month forward by `delta` months, returning { year, month }. */
function rollMonth(year, month, delta) {
  const zeroBased = month - 1 + delta
  const rolledYear = year + Math.floor(zeroBased / 12)
  const rolledMonth = ((zeroBased % 12) + 12) % 12
  return { year: rolledYear, month: rolledMonth + 1 }
}

const QUARTER_MONTHS = {
  1: [4, 6],
  2: [7, 9],
  3: [10, 12],
  4: [1, 3], // calendar year is `year + 1`
}

function validatePeriod({ periodType, year, month, quarter }) {
  if (periodType !== 'MONTH' && periodType !== 'QUARTER') {
    throw new Error(`Invalid periodType: ${periodType} (expected MONTH or QUARTER)`)
  }
  if (!Number.isInteger(year)) {
    throw new Error(`Invalid year: ${year}`)
  }
  if (periodType === 'MONTH' && !(Number.isInteger(month) && month >= 1 && month <= 12)) {
    throw new Error(`Invalid month: ${month} (expected 1-12)`)
  }
  if (periodType === 'QUARTER' && !(Number.isInteger(quarter) && quarter >= 1 && quarter <= 4)) {
    throw new Error(`Invalid quarter: ${quarter} (expected 1-4)`)
  }
}

/**
 * @returns {{ startDate: string, endDate: string }} 'YYYY-MM-DD', inclusive.
 */
export function getGstr1PeriodRange({ periodType, year, month, quarter }) {
  validatePeriod({ periodType, year, month, quarter })

  if (periodType === 'MONTH') {
    return {
      startDate: toDateString(year, month, 1),
      endDate: toDateString(year, month, lastDayOfMonth(year, month)),
    }
  }

  const [startMonth, endMonth] = QUARTER_MONTHS[quarter]
  const calendarYear = quarter === 4 ? year + 1 : year
  return {
    startDate: toDateString(calendarYear, startMonth, 1),
    endDate: toDateString(calendarYear, endMonth, lastDayOfMonth(calendarYear, endMonth)),
  }
}

/**
 * @returns {string} 'YYYY-MM-DD' statutory GSTR-1 due date for the period.
 */
export function getGstr1DueDate({ periodType, year, month, quarter }) {
  validatePeriod({ periodType, year, month, quarter })

  if (periodType === 'MONTH') {
    const next = rollMonth(year, month, 1)
    return toDateString(next.year, next.month, 11)
  }

  const [, endMonth] = QUARTER_MONTHS[quarter]
  const calendarYear = quarter === 4 ? year + 1 : year
  const next = rollMonth(calendarYear, endMonth, 1)
  return toDateString(next.year, next.month, 13)
}

/**
 * Convenience wrapper combining both, plus the filing frequency label used
 * by the dashboard's due-date banner.
 */
export function getGstr1Period(params) {
  const { startDate, endDate } = getGstr1PeriodRange(params)
  return {
    startDate,
    endDate,
    dueDate: getGstr1DueDate(params),
    filingFrequency: params.periodType === 'QUARTER' ? 'QUARTERLY' : 'MONTHLY',
  }
}
