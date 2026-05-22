import { AdminAuthRepository } from './auth.repository.js'
import { AdminAuthService } from './auth.service.js'
import { AdminAuthController } from './auth.controller.js'
import { adminLoginSchema, setPasswordSchema } from './auth.schema.js'

/**
 * Admin auth routes — email + password login
 * Prefix: /api/v1/admin/auth
 *
 * POST /login    — public
 * GET  /me       — validate token, return admin profile
 * POST /logout   — clear auth cookies
 * PUT  /password — requires authenticated ADMIN
 */
export default async function adminAuthRoutes(fastify) {
  const repository = new AdminAuthRepository()
  const service = new AdminAuthService(repository)
  const controller = new AdminAuthController(service)

  // Public login — rate limiting OFF
  fastify.post('/login', {
    schema: adminLoginSchema,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '10 minutes',
      },
    },
  }, controller.login.bind(controller))

  // Validate token — used by dashboard on startup to check if session is still valid
  fastify.get('/me', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
  }, controller.me.bind(controller))

  // Logout — clear cookies
  fastify.post('/logout', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '5 minutes',
      },
    },
  }, controller.logout.bind(controller))

  // Set / change password — requires existing admin auth
  fastify.put('/password', {
    schema: setPasswordSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 hour',
      },
    },
  }, controller.setPassword.bind(controller))
}
