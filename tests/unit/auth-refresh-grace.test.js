import { beforeEach, describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════
// Covers AuthService#refreshToken's rotation grace window.
//
// Bug this guards against: two renewal calls landing close together for
// the same user (e.g. several screens reloading at once right after a push
// notification wakes the app) used to race against Redis's single-slot
// refresh-token storage. The first call rotated the token; the second —
// still holding the token that was valid a moment earlier — was rejected
// outright as "invalid session", forcing a false logout even though the
// session was perfectly valid. The grace window lets that second call
// succeed instead. See src/modules/auth/auth.service.js.
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

vi.mock('../../src/config/redis.js', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
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
import { signAccessToken, verifyToken } from '../../src/utils/jwt.js'
import { redis } from '../../src/config/redis.js'

const USER_ID = 'user-123'
const CURRENT_TOKEN = 'current.refresh.jwt'
const PREVIOUS_TOKEN = 'previous.refresh.jwt'
const UNKNOWN_TOKEN = 'never-issued.refresh.jwt'

function makeRepo(overrides = {}) {
  return {
    findById: vi.fn(async () => ({
      id: USER_ID,
      phone: '9999999999',
      role: 'CUSTOMER',
      is_active: true,
    })),
    ...overrides,
  }
}

describe('AuthService#refreshToken — rotation grace window', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyToken.mockReturnValue({ id: USER_ID })
  })

  it('rotates normally when the token matches the current stored one', async () => {
    redis.get.mockImplementation(async (key) => {
      if (key === `refresh:${USER_ID}`) return CURRENT_TOKEN
      return null
    })

    const service = new AuthService(makeRepo())
    const result = await service.refreshToken(CURRENT_TOKEN)

    expect(result).toEqual({
      success: true,
      accessToken: 'rotated.access.jwt',
      refreshToken: 'rotated.refresh.jwt',
    })
    // Grace key is seeded with the token being superseded before rotation.
    expect(redis.set).toHaveBeenCalledWith(
      `refresh:grace:${USER_ID}`,
      CURRENT_TOKEN,
      'EX',
      30
    )
    expect(redis.set).toHaveBeenCalledWith(
      `refresh:${USER_ID}`,
      'rotated.refresh.jwt',
      'EX',
      7 * 24 * 60 * 60
    )
  })

  it('accepts a just-superseded token within the grace window instead of failing', async () => {
    redis.get.mockImplementation(async (key) => {
      if (key === `refresh:${USER_ID}`) return CURRENT_TOKEN
      if (key === `refresh:grace:${USER_ID}`) return PREVIOUS_TOKEN
      return null
    })

    const service = new AuthService(makeRepo())
    const result = await service.refreshToken(PREVIOUS_TOKEN)

    expect(result.success).toBe(true)
    expect(result.accessToken).toBe('new.access.jwt')
    // Converges on the already-current refresh token — does not rotate again.
    expect(result.refreshToken).toBe(CURRENT_TOKEN)
    expect(signAccessToken).toHaveBeenCalledWith({
      id: USER_ID,
      phone: '9999999999',
      role: 'CUSTOMER',
    })
  })

  it('rejects a token that is neither current nor within the grace window', async () => {
    redis.get.mockImplementation(async (key) => {
      if (key === `refresh:${USER_ID}`) return CURRENT_TOKEN
      if (key === `refresh:grace:${USER_ID}`) return PREVIOUS_TOKEN
      return null
    })

    const service = new AuthService(makeRepo())
    const result = await service.refreshToken(UNKNOWN_TOKEN)

    expect(result).toEqual({
      success: false,
      message: 'Invalid or expired refresh token',
    })
  })

  it('rejects when there is no active session at all (logged out)', async () => {
    redis.get.mockResolvedValue(null)

    const service = new AuthService(makeRepo())
    const result = await service.refreshToken(PREVIOUS_TOKEN)

    expect(result).toEqual({
      success: false,
      message: 'Invalid or expired refresh token',
    })
  })
})

describe('AuthService#logout / deleteAccount — clear the grace key too', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logout clears both the current and grace refresh-token keys', async () => {
    const service = new AuthService(makeRepo())
    await service.logout(USER_ID)

    expect(redis.del).toHaveBeenCalledWith(`refresh:${USER_ID}`)
    expect(redis.del).toHaveBeenCalledWith(`refresh:grace:${USER_ID}`)
  })

  it('deleteAccount clears both the current and grace refresh-token keys', async () => {
    const repo = makeRepo({ deleteUser: vi.fn() })
    const service = new AuthService(repo)
    await service.deleteAccount(USER_ID)

    expect(repo.deleteUser).toHaveBeenCalledWith(USER_ID)
    expect(redis.del).toHaveBeenCalledWith(`refresh:${USER_ID}`)
    expect(redis.del).toHaveBeenCalledWith(`refresh:grace:${USER_ID}`)
  })
})
