import { describe, it, expect } from 'vitest'
import {
  normalizeStateToGstCode,
  formatPlaceOfSupply,
  HOME_STATE_CODE,
  GST_STATE_CODES,
} from '../../../src/utils/gstStateCodes.js'

describe('normalizeStateToGstCode', () => {
  it('matches an exact code', () => {
    expect(normalizeStateToGstCode('24')).toEqual({ code: '24', name: 'Gujarat', matched: true })
  })

  it('matches a state name case-insensitively', () => {
    expect(normalizeStateToGstCode('gujarat')).toEqual({ code: '24', name: 'Gujarat', matched: true })
    expect(normalizeStateToGstCode('WEST BENGAL')).toEqual({ code: '19', name: 'West Bengal', matched: true })
  })

  it('resolves known aliases (Orissa, Pondicherry, NCT of Delhi)', () => {
    expect(normalizeStateToGstCode('Orissa')).toEqual({ code: '21', name: 'Odisha', matched: true })
    expect(normalizeStateToGstCode('Pondicherry')).toEqual({ code: '34', name: 'Puducherry', matched: true })
    expect(normalizeStateToGstCode('NCT of Delhi')).toEqual({ code: '07', name: 'Delhi', matched: true })
  })

  it('returns matched:false and preserves the raw input for unrecognized/blank state', () => {
    expect(normalizeStateToGstCode('Narnia')).toEqual({ code: null, name: 'Narnia', matched: false })
    expect(normalizeStateToGstCode('')).toEqual({ code: null, name: 'Unknown', matched: false })
    expect(normalizeStateToGstCode(null)).toEqual({ code: null, name: 'Unknown', matched: false })
    expect(normalizeStateToGstCode(undefined)).toEqual({ code: null, name: 'Unknown', matched: false })
  })

  it('HOME_STATE_CODE is Gujarat (24), matching STORE_INFO.gstNo', () => {
    expect(HOME_STATE_CODE).toBe('24')
    expect(GST_STATE_CODES[HOME_STATE_CODE]).toBe('Gujarat')
  })
})

describe('formatPlaceOfSupply', () => {
  it('formats as "code-name" matching the GSTR-1 reference template', () => {
    expect(formatPlaceOfSupply('24', 'Gujarat')).toBe('24-Gujarat')
  })

  it('falls back to the bare name when there is no code', () => {
    expect(formatPlaceOfSupply(null, 'Narnia')).toBe('Narnia')
  })
})
