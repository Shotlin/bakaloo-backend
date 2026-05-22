import { success, error } from '../../../utils/apiResponse.js'

const TWENTY_DAYS_SECONDS = 20 * 24 * 60 * 60 // 1,728,000 seconds

export class AdminAuthController {
  constructor(service) {
    this.service = service
  }

  async login(request, reply) {
    try {
      const { email, password } = request.body
      const ip = request.ip
      const admin = await this.service.login({ email, password }, ip)

      // Sign JWT with 20-day expiry for admin sessions
      const token = await reply.jwtSign(
        { id: admin.id, phone: admin.phone, role: admin.role },
        { expiresIn: '20d' }
      )

      // Set accessToken as httpOnly cookie so it persists across backend restarts
      reply.setCookie('accessToken', token, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: TWENTY_DAYS_SECONDS,
      })

      // Also set a non-httpOnly marker cookie for the Next.js middleware
      reply.setCookie('auth_session', '1', {
        path: '/',
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: TWENTY_DAYS_SECONDS,
      })

      return reply.code(200).send(success({
        accessToken: token,
        user: admin,
      }, 'Login successful'))
    } catch (err) {
      const code = err.statusCode || 500
      return reply.code(code).send(error(err.message, 'AUTH_ERROR'))
    }
  }

  async setPassword(request, reply) {
    try {
      const { password } = request.body
      await this.service.setPassword(request.user.id, password)
      return reply.code(200).send(success(null, 'Password updated'))
    } catch (err) {
      const code = err.statusCode || 500
      return reply.code(code).send(error(err.message, 'SET_PASSWORD_ERROR'))
    }
  }

  async me(request, reply) {
    try {
      const admin = await this.service.getProfile(request.user.id)
      if (!admin) {
        return reply.code(401).send(error('Admin not found', 'UNAUTHORIZED'))
      }
      return reply.code(200).send(success(admin, 'Profile fetched'))
    } catch (err) {
      return reply.code(500).send(error(err.message, 'PROFILE_ERROR'))
    }
  }

  async logout(request, reply) {
    // Clear both cookies
    reply.clearCookie('accessToken', { path: '/' })
    reply.clearCookie('auth_session', { path: '/' })
    return reply.code(200).send(success(null, 'Logged out'))
  }
}
