import { generateOTP, storeOTP, verifyOTP } from '../../utils/otp.js'
import { sendSmsOtp, verifySmsOtp } from '../../utils/sms.js'
import { generateTokenPair, verifyToken } from '../../utils/jwt.js'
import { orderQueue } from '../../config/bullmq.js'
import { redis } from '../../config/redis.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'

const REFRESH_TOKEN_PREFIX = 'refresh:'
const SMS_SESSION_PREFIX = 'sms:session:'

function normalizePhoneForOtp(phone) {
  const digits = `${phone || ''}`.replace(/\D/g, '')
  if (digits.startsWith('91') && digits.length === 12) return digits.slice(2)
  return digits
}

/**
 * Auth service — business logic for authentication
 */
export class AuthService {
  constructor(repository) {
    this.repo = repository
  }

  _isDemoOtpEnabled() {
    return env.ALLOW_DEMO_OTP && Boolean(env.DEMO_OTP_PHONE)
  }

  _isDemoOtpPhone(phone) {
    if (!this._isDemoOtpEnabled()) return false
    return normalizePhoneForOtp(phone) === normalizePhoneForOtp(env.DEMO_OTP_PHONE)
  }

  /**
   * Send OTP to a phone number
   * Production: sends via 2Factor.in SMS
   * Development: returns OTP in response for testing
   */
  async sendOtp(phone) {
    if (this._isDemoOtpPhone(phone)) {
      await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
      logger.info({ phone: phone.slice(-4) }, 'Demo OTP bypass used')
      return {
        otp: env.DEMO_OTP_CODE,
        isDemoOtp: true,
      }
    }

    // Production mode — use 2Factor.in
    if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === '2factor') {
      const smsResult = await sendSmsOtp(phone)

      if (!smsResult.success) {
        logger.error({ phone: phone.slice(-4) }, '2Factor SMS failed, falling back to dev OTP')
        // Fall through to dev mode as fallback
      } else {
        // Store session ID for verification
        await redis.set(
          `${SMS_SESSION_PREFIX}${phone}`,
          smsResult.sessionId,
          'EX',
          env.OTP_EXPIRY_SECONDS
        )
        logger.info({ phone: phone.slice(-4) }, 'OTP sent via 2Factor SMS')
        return {}
      }
    }

    // Development mode OR 2Factor with SMS_PROVIDER=2factor in dev (for testing real SMS)
    if (env.SMS_PROVIDER === '2factor' && env.TWO_FACTOR_API_KEY) {
      const smsResult = await sendSmsOtp(phone)

      if (smsResult.success) {
        await redis.set(
          `${SMS_SESSION_PREFIX}${phone}`,
          smsResult.sessionId,
          'EX',
          env.OTP_EXPIRY_SECONDS
        )
        logger.info({ phone: phone.slice(-4) }, 'OTP sent via 2Factor SMS (dev)')
        return { smsOtp: true }  // Flag: tell controller not to return OTP
      }
    }

    // Fallback: generate local OTP (dev testing)
    const otp = generateOTP()
    await storeOTP(phone, otp)

    logger.info({ phone: phone.slice(-4) }, 'OTP generated (local)')

    if (env.NODE_ENV === 'development') {
      logger.debug({ otp }, 'DEV OTP (remove in production)')
      return { otp }
    }

    return {}
  }

  /**
   * Verify OTP and return JWT tokens
   * Tries 2Factor.in verification first, then falls back to local Redis OTP
   */
  async verifyOtp(phone, otp, role) {
    let otpValid = false

    if (this._isDemoOtpPhone(phone)) {
      if (`${otp || ''}`.trim() !== env.DEMO_OTP_CODE) {
        return { success: false, message: 'Invalid OTP' }
      }
      otpValid = true
      await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
      logger.info({ phone: phone.slice(-4) }, 'Demo OTP verified')
    }

    // Try 2Factor.in verification first
    const sessionId = otpValid ? null : await redis.get(`${SMS_SESSION_PREFIX}${phone}`)

    if (sessionId) {
      const smsResult = await verifySmsOtp(sessionId, otp)
      if (smsResult.success) {
        otpValid = true
        await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
      } else {
        return { success: false, message: smsResult.message || 'Invalid OTP' }
      }
    }

    // Fallback: local Redis OTP verification
    if (!otpValid) {
      const result = await verifyOTP(phone, otp)
      if (!result.valid) {
        return { success: false, message: result.message }
      }
    }

    // Normalize role: RIDER, DELIVERY → 'RIDER' (canonical value)
    const requestedRole = (role === 'RIDER' || role === 'DELIVERY') ? 'RIDER' : null

    // Find or create user
    let user = await this.repo.findByPhone(phone)
    let isNewUser = false

    if (!user) {
      user = await this.repo.createUser(phone, requestedRole || 'CUSTOMER')
      isNewUser = true
      logger.info({ userId: user.id, role: user.role }, 'New user registered')

      // Auto-create rider_profile for new RIDER registrations
      if (user.role === 'RIDER') {
        await this.repo.ensureRiderProfile(user.id)
        logger.info({ userId: user.id }, 'Auto-created rider_profile for new rider')
      }
    } else if (requestedRole === 'RIDER' && user.role === 'CUSTOMER') {
      // Existing customer registering as rider via rider app
      await this.repo.updateRole(user.id, 'RIDER')
      user.role = 'RIDER'
      await this.repo.ensureRiderProfile(user.id)
      logger.info({ userId: user.id }, 'Upgraded CUSTOMER to RIDER with rider_profile')
    }

    // Check if user is blocked
    if (!user.is_active) {
      return { success: false, message: 'Your account has been blocked. Contact support.' }
    }

    // Generate JWT pair
    const payload = { id: user.id, phone: user.phone, role: user.role }
    const tokens = generateTokenPair(payload)

    // Store refresh token in Redis (for invalidation on logout)
    await redis.set(
      `${REFRESH_TOKEN_PREFIX}${user.id}`,
      tokens.refreshToken,
      'EX',
      7 * 24 * 60 * 60 // 7 days
    )

    // For RIDER users, fetch rider_profile to get verification (approval) status
    let isVerified = false
    if (user.role === 'RIDER') {
      const riderProfile = await this.repo.getRiderProfile(user.id)
      isVerified = riderProfile?.is_approved === true
      if (isVerified) {
        await this._queueBacklogAssignScan('RIDER_LOGIN')
      }
    }

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        isNewUser,
        isVerified,
      },
    }
  }

  /**
   * Refresh access token using a valid refresh token
   */
  async refreshToken(refreshToken) {
    try {
      const decoded = verifyToken(refreshToken, env.JWT_REFRESH_SECRET)

      // Check if refresh token is still valid in Redis
      const stored = await redis.get(`${REFRESH_TOKEN_PREFIX}${decoded.id}`)
      if (!stored || stored !== refreshToken) {
        return { success: false, message: 'Invalid or expired refresh token' }
      }

      // Check user still exists and is active
      const user = await this.repo.findById(decoded.id)
      if (!user || !user.is_active) {
        return { success: false, message: 'User account is not active' }
      }

      // Generate new token pair (rotate refresh token)
      const payload = { id: user.id, phone: user.phone, role: user.role }
      const tokens = generateTokenPair(payload)

      // Update refresh token in Redis
      await redis.set(
        `${REFRESH_TOKEN_PREFIX}${user.id}`,
        tokens.refreshToken,
        'EX',
        7 * 24 * 60 * 60
      )

      return {
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Refresh token verification failed')
      return { success: false, message: 'Invalid or expired refresh token' }
    }
  }

  /**
   * Logout — invalidate refresh token
   */
  async logout(userId) {
    await redis.del(`${REFRESH_TOKEN_PREFIX}${userId}`)
    logger.info({ userId }, 'User logged out')
  }

  /**
   * Delete user account (GDPR compliance)
   */
  async deleteAccount(userId) {
    await this.repo.deleteUser(userId)
    await redis.del(`${REFRESH_TOKEN_PREFIX}${userId}`)
    logger.info({ userId }, 'User account deleted')
  }

  async _queueBacklogAssignScan(source) {
    try {
      await orderQueue.add(
        'auto-assign-backlog',
        {
          type: 'auto-assign-backlog',
          source,
          limit: 500,
        },
        {
          jobId: 'auto-assign-backlog-on-rider-login',
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    } catch (err) {
      logger.warn({ err, source }, 'Failed to queue rider backlog assignment scan')
    }
  }
}
