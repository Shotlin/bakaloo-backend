import fp from 'fastify-plugin'
import fjwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import { env } from '../config/env.js'
import { query } from '../config/database.js'

/**
 * Auth plugin — registers JWT + Cookie support
 * Decorates fastify with `authenticate` and `authorize` preHandlers
 */
async function authPlugin(fastify) {
  // Cookie support (for httpOnly refresh token cookie)
  await fastify.register(cookie, {
    secret: env.COOKIE_SECRET || env.JWT_ACCESS_SECRET,
    parseOptions: {},
  })

  // JWT support (only access token verification via this plugin)
  await fastify.register(fjwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: {
      expiresIn: env.JWT_ACCESS_EXPIRY,
    },
    cookie: {
      cookieName: 'accessToken',
      signed: false,
    },
  })

  /**
   * preHandler: Verify JWT from Authorization header or cookie
   * Attaches decoded payload to request.user
   * Also checks if user is blocked
   */
  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify()

      // Check if user is blocked
      const { rows } = await query(
        'SELECT is_blocked FROM users WHERE id = $1',
        [request.user.id]
      )
      if (rows.length > 0 && rows[0].is_blocked) {
        return reply.code(403).send({
          success: false,
          message: 'Account is blocked. Contact support.',
          code: 'ACCOUNT_BLOCKED',
        })
      }
    } catch (err) {
      reply.code(401).send({
        success: false,
        message: 'Unauthorized — invalid or expired token',
        code: 'UNAUTHORIZED',
      })
    }
  })

  /**
   * preHandler factory: Check if user has one of the allowed roles
   * Must be used AFTER authenticate
   * Usage: preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])]
   */
  fastify.decorate('authorize', function (allowedRoles) {
    return async function (request, reply) {
      const { role } = request.user
      if (!allowedRoles.includes(role)) {
        reply.code(403).send({
          success: false,
          message: 'Forbidden — insufficient permissions',
          code: 'FORBIDDEN',
        })
      }
    }
  })

  /**
   * preHandler: Check if user has ADMIN role
   * Must be used AFTER authenticate
   * Usage: preHandler: [fastify.authenticate, fastify.requireAdmin]
   */
  fastify.decorate('requireAdmin', async function (request, reply) {
    const { role } = request.user
    if (role !== 'ADMIN') {
      reply.code(403).send({
        success: false,
        message: 'Forbidden — admin access required',
        code: 'FORBIDDEN',
      })
    }
  })

  /**
   * preHandler factory: Check if user has a specific permission via their role
   * Must be used AFTER authenticate
   * Usage: preHandler: [fastify.authenticate, fastify.requireAdmin, fastify.requirePermission('products.manage')]
   */
  fastify.decorate('requirePermission', function (permission) {
    return async function (request, reply) {
      const { id } = request.user
      const { rows } = await query(
        `SELECT COALESCE(r.permissions, '[]'::jsonb) AS permissions
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1`,
        [id]
      )
      const perms = rows[0]?.permissions || []
      if (!perms.includes(permission)) {
        reply.code(403).send({
          success: false,
          message: `Forbidden — requires '${permission}' permission`,
          code: 'PERMISSION_DENIED',
        })
      }
    }
  })
}

export default fp(authPlugin, { name: 'auth' })
