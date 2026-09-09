// Spin & Win — weighted-pick distribution property tests.
// Mirrors coupon-distribution.property.test.js's shape: pickWeightedPrize
// is a pure function (no DB/service scaffolding), so no vi.mock needed at
// all here — a real, seeded PRNG drives it directly.
//
// Properties covered:
//   A — boundary correctness (0%, 100%, float-sum-just-under-100 edge case)
//   B — statistical distribution over many trials stays within tolerance
//       of each prize's configured probability
//   C — every trial returns exactly one prize; counts sum to N exactly

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { pickWeightedPrize } from '../../src/modules/spin-wheel/spin-wheel.service.js'

const SEED = 20260115
const TRIALS = 100_000

/** Deterministic seeded PRNG (mulberry32) — same seed always reproduces the same sequence, independent of Math.random's own state. */
function seededRandom(seed) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('pickWeightedPrize — boundaries', () => {
  it('a single 100%-probability prize is always picked', () => {
    const prizes = [{ id: 'only', winProbability: 100 }]
    const rand = seededRandom(SEED)
    for (let i = 0; i < 1000; i++) {
      expect(pickWeightedPrize(prizes, rand).id).toBe('only')
    }
  })

  it('a 0%-probability prize is never picked across many trials', () => {
    const prizes = [
      { id: 'never', winProbability: 0 },
      { id: 'always', winProbability: 100 },
    ]
    const rand = seededRandom(SEED)
    for (let i = 0; i < 10_000; i++) {
      expect(pickWeightedPrize(prizes, rand).id).toBe('always')
    }
  })

  it('falls back to the last prize when float rounding leaves the cumulative sum a hair under 100', () => {
    // 33.33 * 3 = 99.99, not 100 — roll near the very top of the range must
    // still resolve to the last prize instead of returning undefined.
    const prizes = [
      { id: 'a', winProbability: 33.33 },
      { id: 'b', winProbability: 33.33 },
      { id: 'c', winProbability: 33.33 },
    ]
    const result = pickWeightedPrize(prizes, () => 0.9999999)
    expect(result.id).toBe('c')
  })

  it('picks the first prize whose cumulative range contains the roll', () => {
    const prizes = [
      { id: 'a', winProbability: 20 },
      { id: 'b', winProbability: 30 },
      { id: 'c', winProbability: 50 },
    ]
    expect(pickWeightedPrize(prizes, () => 0.10).id).toBe('a') // 10 < 20
    expect(pickWeightedPrize(prizes, () => 0.25).id).toBe('b') // 20 <= 25 < 50
    expect(pickWeightedPrize(prizes, () => 0.99).id).toBe('c') // 50 <= 99 < 100
  })
})

describe('pickWeightedPrize — statistical distribution (100k trials)', () => {
  it('observed frequency stays within ±1.5 points of configured probability, for a skewed 5-prize wheel', () => {
    const prizes = [
      { id: 'p28', winProbability: 28 },
      { id: 'p30', winProbability: 30 },
      { id: 'p20', winProbability: 20 },
      { id: 'p1', winProbability: 1 },
      { id: 'restToBetterLuck', winProbability: 21 }, // sums to 100
    ]
    const rand = seededRandom(SEED)
    const counts = Object.fromEntries(prizes.map((p) => [p.id, 0]))

    for (let i = 0; i < TRIALS; i++) {
      counts[pickWeightedPrize(prizes, rand).id] += 1
    }

    const totalCounted = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(totalCounted).toBe(TRIALS) // every trial landed on exactly one prize

    for (const prize of prizes) {
      const observedPct = (counts[prize.id] / TRIALS) * 100
      expect(Math.abs(observedPct - prize.winProbability)).toBeLessThanOrEqual(1.5)
    }
  })

  it('a rare 0.1% prize is still reachable (not silently starved) over 100k trials', () => {
    const prizes = [
      { id: 'common', winProbability: 99.9 },
      { id: 'rare', winProbability: 0.1 },
    ]
    const rand = seededRandom(SEED + 1)
    let rareCount = 0
    for (let i = 0; i < TRIALS; i++) {
      if (pickWeightedPrize(prizes, rand).id === 'rare') rareCount += 1
    }
    // Expected ~100 hits over 100k trials — allow a wide but sane band
    // (Poisson-ish variance at this rate) rather than an exact match.
    expect(rareCount).toBeGreaterThan(20)
    expect(rareCount).toBeLessThan(300)
  })
})

describe('pickWeightedPrize — property: distribution matches configured weights for arbitrary 2-8 prize wheels', () => {
  const wheelArb = fc
    .array(fc.integer({ min: 1, max: 1000 }), { minLength: 2, maxLength: 8 })
    .map((weights) => {
      const sum = weights.reduce((a, b) => a + b, 0)
      // Normalize to sum exactly 100.00, largest-remainder style so the
      // rounding itself can't be the source of a failed assertion.
      const raw = weights.map((w) => (w / sum) * 100)
      const floored = raw.map((v) => Math.floor(v * 100) / 100)
      let remainder = Math.round((100 - floored.reduce((a, b) => a + b, 0)) * 100)
      const order = raw
        .map((v, i) => ({ i, frac: v * 100 - Math.floor(v * 100) }))
        .sort((a, b) => b.frac - a.frac)
      const probs = [...floored]
      for (let k = 0; k < order.length && remainder > 0; k++) {
        probs[order[k].i] = Math.round((probs[order[k].i] + 0.01) * 100) / 100
        remainder -= 1
      }
      return probs.map((winProbability, i) => ({ id: `prize-${i}`, winProbability }))
    })

  it('every generated wheel sums to exactly 100 and is fully reachable', () => {
    fc.assert(
      fc.property(wheelArb, (prizes) => {
        const sum = prizes.reduce((a, p) => a + p.winProbability, 0)
        expect(Math.round(sum * 100) / 100).toBe(100)

        const rand = seededRandom(SEED + 2)
        const counts = Object.fromEntries(prizes.map((p) => [p.id, 0]))
        const trials = 5000
        for (let i = 0; i < trials; i++) {
          counts[pickWeightedPrize(prizes, rand).id] += 1
        }
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(trials)
        // Every non-zero-probability prize got picked at least once.
        for (const prize of prizes) {
          if (prize.winProbability > 0) {
            expect(counts[prize.id]).toBeGreaterThan(0)
          }
        }
      }),
      { numRuns: 30, seed: SEED }
    )
  })
})
