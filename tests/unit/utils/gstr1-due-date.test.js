import { describe, it, expect } from 'vitest'
import {
  getGstr1PeriodRange,
  getGstr1DueDate,
  getGstr1Period,
} from '../../../src/utils/gstr1DueDate.js'

describe('getGstr1PeriodRange', () => {
  it('returns the full calendar month for a MONTH period', () => {
    expect(getGstr1PeriodRange({ periodType: 'MONTH', year: 2026, month: 4 })).toEqual({
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    })
  })

  it('handles a 31-day month and February correctly', () => {
    expect(getGstr1PeriodRange({ periodType: 'MONTH', year: 2026, month: 1 })).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    })
    expect(getGstr1PeriodRange({ periodType: 'MONTH', year: 2028, month: 2 })).toEqual({
      startDate: '2028-02-01',
      endDate: '2028-02-29', // 2028 is a leap year
    })
  })

  it('returns Apr-Jun for Q1', () => {
    expect(getGstr1PeriodRange({ periodType: 'QUARTER', year: 2026, quarter: 1 })).toEqual({
      startDate: '2026-04-01',
      endDate: '2026-06-30',
    })
  })

  it('returns Jan-Mar of year+1 for Q4 (FY year is the START year)', () => {
    expect(getGstr1PeriodRange({ periodType: 'QUARTER', year: 2026, quarter: 4 })).toEqual({
      startDate: '2027-01-01',
      endDate: '2027-03-31',
    })
  })

  it('throws on an invalid periodType/month/quarter', () => {
    expect(() => getGstr1PeriodRange({ periodType: 'YEAR', year: 2026 })).toThrow()
    expect(() => getGstr1PeriodRange({ periodType: 'MONTH', year: 2026, month: 13 })).toThrow()
    expect(() => getGstr1PeriodRange({ periodType: 'QUARTER', year: 2026, quarter: 5 })).toThrow()
  })
})

describe('getGstr1DueDate', () => {
  it('monthly: due on the 11th of the next month', () => {
    expect(getGstr1DueDate({ periodType: 'MONTH', year: 2026, month: 4 })).toBe('2026-05-11')
  })

  it('monthly: rolls over the calendar year (Dec -> Jan)', () => {
    expect(getGstr1DueDate({ periodType: 'MONTH', year: 2026, month: 12 })).toBe('2027-01-11')
  })

  it('quarterly: due on the 13th of the month after the quarter ends', () => {
    expect(getGstr1DueDate({ periodType: 'QUARTER', year: 2026, quarter: 1 })).toBe('2026-07-13') // Q1 Apr-Jun -> due 13 Jul
    expect(getGstr1DueDate({ periodType: 'QUARTER', year: 2026, quarter: 2 })).toBe('2026-10-13') // Q2 Jul-Sep -> due 13 Oct
    expect(getGstr1DueDate({ periodType: 'QUARTER', year: 2026, quarter: 3 })).toBe('2027-01-13') // Q3 Oct-Dec -> due 13 Jan (next year)
  })

  it('quarterly: Q4 (Jan-Mar of year+1) due 13 Apr of year+1', () => {
    expect(getGstr1DueDate({ periodType: 'QUARTER', year: 2026, quarter: 4 })).toBe('2027-04-13')
  })
})

describe('getGstr1Period', () => {
  it('combines range + due date + filing frequency for MONTH', () => {
    expect(getGstr1Period({ periodType: 'MONTH', year: 2026, month: 4 })).toEqual({
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      dueDate: '2026-05-11',
      filingFrequency: 'MONTHLY',
    })
  })

  it('combines range + due date + filing frequency for QUARTER', () => {
    expect(getGstr1Period({ periodType: 'QUARTER', year: 2026, quarter: 1 })).toEqual({
      startDate: '2026-04-01',
      endDate: '2026-06-30',
      dueDate: '2026-07-13',
      filingFrequency: 'QUARTERLY',
    })
  })
})
