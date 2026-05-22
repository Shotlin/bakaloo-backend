import { success, error } from '../../utils/apiResponse.js'
import { env } from '../../config/env.js'

/**
 * Auth controller — thin HTTP layer
 * Parses request, calls service, formats response
 */
export class AuthController {
  constructor(service) {
    this.service = service
  }

  /**
   * POST /send-otp
   */
  async sendOtp(request, reply) {
    const { phone } = request.body

    const result = await this.service.sendOtp(phone)

    // If OTP was sent via SMS (2Factor), don't expose OTP in response
    if (result.smsOtp) {
      return reply.code(200).send(success({}, 'OTP sent to your phone via SMS'))
    }

    const data = result.otp && (env.NODE_ENV === 'development' || result.isDemoOtp)
      ? { otp: result.otp, isDemoOtp: Boolean(result.isDemoOtp) }
      : {}
    return reply.code(200).send(success(data, 'OTP sent successfully'))
  }

  /**
   * POST /verify-otp
   */
  async verifyOtp(request, reply) {
    const { phone, otp, role } = request.body

    const result = await this.service.verifyOtp(phone, otp, role)

    if (!result.success) {
      return reply.code(400).send(error(result.message, 'INVALID_OTP'))
    }

    // Set refresh token as httpOnly cookie
    reply.setCookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60, // 7 days
    })

    return reply.code(200).send(
      success(
        {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          user: result.user,
        },
        result.user.isNewUser ? 'Account created successfully' : 'Login successful'
      )
    )
  }

  /**
   * POST /refresh-token
   */
  async refreshToken(request, reply) {
    const { refreshToken } = request.body

    if (!refreshToken) {
      return reply.code(400).send(error('Refresh token is required', 'REFRESH_TOKEN_REQUIRED'))
    }

    const result = await this.service.refreshToken(refreshToken)

    if (!result.success) {
      return reply.code(401).send(error(result.message, 'INVALID_REFRESH_TOKEN'))
    }

    // Update refresh token cookie
    reply.setCookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60,
    })

    return reply.code(200).send(
      success({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      }, 'Token refreshed successfully')
    )
  }

  /**
   * POST /logout
   */
  async logout(request, reply) {
    await this.service.logout(request.user.id)

    reply.clearCookie('refreshToken', { path: '/api/v1/auth' })

    return reply.code(200).send(success(null, 'Logged out successfully'))
  }

  /**
   * DELETE /account
   */
  async deleteAccount(request, reply) {
    await this.service.deleteAccount(request.user.id)

    reply.clearCookie('refreshToken', { path: '/api/v1/auth' })

    return reply.code(200).send(success(null, 'Account deleted successfully'))
  }
}
