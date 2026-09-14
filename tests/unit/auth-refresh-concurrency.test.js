import { beforeEach, describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════
// Covers AuthService#refreshToken's per-user lock (REFRESH_LOCK_PREFIX).
//
// Bug this guards against: two renewal calls presenting the SAME
// still-current refresh token, landing close enough together that neither
// has written its rotation before the other reads Redis, used to BOTH pass
// the "stored === refreshToken" check and BOTH independently rotate — each
// minting its own new token pair and unconditionally overwriting the
// single refresh:<userId> key. Whichever pair the client didn't happen to
// persist was silently orphaned: it matched neither the new current value
// nor the grace value (which only ever remembers the ONE shared
// pre-rotation token both calls presented), so its very next use was a
// hard, unrecoverable "Invalid or expired refresh token" — a false logout
// of a session that was never actually compromised. This is the real-world
// concurrent case the existing grace window alone (see
// auth-refresh-grace.test.js) cannot absorb, because grace only helps a
// LATE duplicate arriving after a single rotation has already completed,
// not two callers racing to rotate at the same instant. See
// src/modules/auth/auth.service.js.
//
// Uses a small in-memory fake Redis (not bare vi.fn() mocks) so the two
// concurrent calls actually interleave against shared, stateful storage —
// a real regression here would otherwise be invisible to call-and-response
// style mocking.
// ═══════════════════════════════════════════════════════════════

vi.mock('../../src/utils/jwt.js', () => ({
  signAccessToken: vi.fn(() => 'new.access.jwt'),
  signRefreshToken: vi.fn(() => 'new.refresh.jwt'),
  generateTokenPair: vi.fn(() => ({
    accessToken: 'rotated.access.jwt',
    refreshToken: 'rotated.refresh.jwt',
  })),
  verifyToken: vi.fn(),
  refreshTokenTtlSeconds: vi.fn(() => 7 * 24 * 60 * 60),
}))

vi.mock('../../src/utils/otp.js', () => ({
  generateOTP: vi.fn(),
  storeOTP: vi.fn(),
  verifyOTP: vi.fn(),
}))

vi.mock('../../src/utils/sms.js', () => ({
  sendSmsOtp: vi.fn(),
  verifySmsOtp: vi.fn(),
}))

/** Minimal stateful fake covering exactly the GET/SET(EX|PX,NX)/DEL shapes
 *  auth.service.js uses — enough to let two concurrent calls genuinely
 *  race against shared storage instead of independently-scripted mocks. */
function createFakeRedis() {
  const store = new Map()
  const isAlive = (entry) => entry && (!entry.expiresAt || Date.now() <= entry.expiresAt)
  return {
    async get(key) {
      const entry = store.get(key)
      return isAlive(entry) ? entry.value : null
    },
    async set(key, value, ...opts) {
      let ttlMs = null
      let nx = false
      for (let i = 0; i < opts.length; i++) {
        if (opts[i] === 'EX') ttlMs = Number(opts[++i]) * 1000
        else if (opts[i] === 'PX') ttlMs = Number(opts[++i])
        else if (opts[i] === 'NX') nx = true
      }
      if (nx && isAlive(store.get(key))) return null
      store.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null })
      return 'OK'
    },
    async del(key) {
      const had = store.has(key)
      store.delete(key)
      return had ? 1 : 0
    },
  }
}

let fakeRedis
vi.mock('../../src/config/redis.js', () => ({
  get redis() {
    return fakeRedis
  },
}))

vi.mock('../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
}))

vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    ALLOW_DEMO_OTP: false,
    DEMO_OTP_PHONE: '',
    DEMO_OTP_CODE: '123456',
    OTP_EXPIRY_SECONDS: 300,
    SMS_PROVIDER: 'none',
    TWO_FACTOR_API_KEY: undefined,
    JWT_REFRESH_SECRET: 'test-refresh-secret-32-chars-min-x',
    JWT_ACCESS_SECRET: 'test-access-secret-32-chars-min-xx',
  },
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { AuthService } from '../../src/modules/auth/auth.service.js'
import { generateTokenPair, verifyToken } from '../../src/utils/jwt.js'

const USER_ID = 'user-123'
const CURRENT_TOKEN = 'current.refresh.jwt'

function makeRepo() {
  return {
    findById: vi.fn(async () => ({
      id: USER_ID,
      phone: '9999999999',
      role: 'CUSTOMER',
      is_active: true,
    })),
  }
}

describe('AuthService#refreshToken — concurrent same-token race', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeRedis = createFakeRedis()
    verifyToken.mockReturnValue({ id: USER_ID })
  })

  it('rotates exactly once and converges both callers on the same pair', async () => {
    await fakeRedis.set(`refresh:${USER_ID}`, CURRENT_TOKEN)

    const service = new AuthService(makeRepo())

    // Two callers present the identical, still-current token at the same
    // time — e.g. the app's cold-start refresh racing an in-flight
    // request's own interceptor-triggered refresh.
    const [first, second] = await Promise.all([
      service.refreshToken(CURRENT_TOKEN),
      service.refreshToken(CURRENT_TOKEN),
    ])

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)

    // The core guarantee: only one caller actually rotated. Before the
    // per-user lock existed, both could pass the equality check before
    // either wrote, so this would be 2 — each minting an independent pair
    // and clobbering the other's write in Redis.
    expect(generateTokenPair).toHaveBeenCalledTimes(1)

    // Both callers must end up holding the SAME refresh token — neither
    // one silently orphaned with a pair Redis no longer recognizes.
    expect(first.refreshToken).toBe(second.refreshToken)
    expect(first.refreshToken).toBe('rotated.refresh.jwt')

    // And that pair must actually be what's live in storage, so a THIRD,
    // later call with either result's refresh token still succeeds.
    const stored = await fakeRedis.get(`refresh:${USER_ID}`)
    expect(stored).toBe('rotated.refresh.jwt')
  })

  it('still succeeds (without a second rotation) when the lock cannot be acquired in time', async () => {
    await fakeRedis.set(`refresh:${USER_ID}`, CURRENT_TOKEN)
    // Simulate permanent lock contention — acquireRefreshLock must fail
    // open (proceed without exclusivity) rather than reject a legitimate
    // refresh outright.
    const realSet = fakeRedis.set.bind(fakeRedis)
    fakeRedis.set = async (key, value, ...opts) => {
      if (key.startsWith('refresh:lock:')) return null
      return realSet(key, value, ...opts)
    }

    const service = new AuthService(makeRepo())
    const result = await service.refreshToken(CURRENT_TOKEN)

    expect(result.success).toBe(true)
    expect(result.refreshToken).toBe('rotated.refresh.jwt')
  }, 10_000)
})
