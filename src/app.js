import Fastify from 'fastify'
import { env } from './config/env.js'
import { query } from './config/database.js'
import { redis } from './config/redis.js'
import { sanitize } from './middlewares/sanitize.js'

/**
 * Build and configure the Fastify application
 * Registers plugins, hooks, and routes in the correct order
 */
export const buildApp = async () => {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.LOG_PRETTY && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
    },
    trustProxy: true,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        useDefaults: true,
        coerceTypes: 'array',
      },
    },
  })

  // ─── PLUGINS (order matters) ────────────────────────────
  await app.register(import('./plugins/errorHandler.plugin.js'))
  await app.register(import('./plugins/cors.plugin.js'))
  await app.register(import('./plugins/helmet.plugin.js'))
  await app.register(import('./plugins/rateLimit.plugin.js'))
  await app.register(import('./plugins/auth.plugin.js'))
  await app.register(import('./plugins/swagger.plugin.js'))
  await app.register(import('./plugins/multipart.plugin.js'))
  await app.register(import('./plugins/compress.plugin.js'))
  await app.register(import('./plugins/socketio.plugin.js'))

  // ─── GLOBAL HOOKS ──────────────────────────────────────
  app.addHook('onRequest', sanitize)

  // ─── MODULE ROUTES ─────────────────────────────────────

  // Auth — fully implemented
  await app.register(import('./modules/auth/auth.routes.js'), {
    prefix: '/api/v1/auth',
  })

  // Users — fully implemented
  await app.register(import('./modules/users/users.routes.js'), {
    prefix: '/api/v1/users',
  })

  // Categories — fully implemented
  await app.register(import('./modules/categories/categories.routes.js'), {
    prefix: '/api/v1/categories',
  })

  // Products — fully implemented
  await app.register(import('./modules/products/products.routes.js'), {
    prefix: '/api/v1/products',
  })

  // Uploads — fully implemented
  await app.register(import('./modules/uploads/uploads.routes.js'), {
    prefix: '/api/v1/uploads',
  })

  // Cart — fully implemented
  await app.register(import('./modules/cart/cart.routes.js'), {
    prefix: '/api/v1/cart',
  })

  // Orders — fully implemented
  await app.register(import('./modules/orders/orders.routes.js'), {
    prefix: '/api/v1/orders',
  })

  // Payments — fully implemented
  await app.register(import('./modules/payments/payments.routes.js'), {
    prefix: '/api/v1/payments',
  })

  // Wallet — fully implemented
  await app.register(import('./modules/wallet/wallet.routes.js'), {
    prefix: '/api/v1/wallet',
  })

  // Coupons — fully implemented
  await app.register(import('./modules/coupons/coupons.routes.js'), {
    prefix: '/api/v1/coupons',
  })

  // Addresses — fully implemented
  await app.register(import('./modules/addresses/addresses.routes.js'), {
    prefix: '/api/v1/addresses',
  })

  // Admin — fully implemented
  await app.register(import('./modules/admin/admin.routes.js'), {
    prefix: '/api/v1/admin',
  })

  // Banners (public) — active banners for mobile/web
  await app.register(import('./modules/banners/banners.routes.js'), {
    prefix: '/api/v1/banners',
  })

  // Theme (public) — active theme for mobile/web app
  await app.register(import('./modules/themes/public.routes.js'), {
    prefix: '/api/v1/theme',
  })

  // Wishlist — fully implemented
  await app.register(import('./modules/wishlist/wishlist.routes.js'), {
    prefix: '/api/v1/wishlist',
  })

  // Reviews — fully implemented
  await app.register(import('./modules/reviews/reviews.routes.js'), {
    prefix: '/api/v1/reviews',
  })

  // Delivery — fully implemented
  await app.register(import('./modules/delivery/delivery.routes.js'), {
    prefix: '/api/v1/delivery',
  })

  // Notifications — fully implemented
  await app.register(import('./modules/notifications/notifications.routes.js'), {
    prefix: '/api/v1/notifications',
  })

  // ─── CART ENHANCEMENT MODULES ──────────────────────────

  // Tip Presets (public)
  await app.register(import('./modules/tip-presets/tip-presets.routes.js'), {
    prefix: '/api/v1/tip-presets',
  })

  // Payment Offers (public)
  await app.register(import('./modules/payment-offers/payment-offers.routes.js'), {
    prefix: '/api/v1/payment-offers',
  })

  // Fee Config (admin)
  await app.register(import('./modules/fee-config/fee-config.routes.js'), {
    prefix: '/api/v1/admin/fee-config',
  })

  // Tip Presets (admin)
  const { adminTipPresetsRoutes } = await import('./modules/tip-presets/tip-presets.routes.js')
  await app.register(adminTipPresetsRoutes, {
    prefix: '/api/v1/admin/tip-presets',
  })

  // Payment Offers (admin)
  const { adminPaymentOffersRoutes } = await import('./modules/payment-offers/payment-offers.routes.js')
  await app.register(adminPaymentOffersRoutes, {
    prefix: '/api/v1/admin/payment-offers',
  })

  // ─── RAZORPAY WEBHOOK (outside /api/v1 — no auth, no rate-limit) ──
  await app.register(async function razorpayWebhook(fastify) {
    // Lazy-load payments dependencies only for this route
    const { PaymentsRepository } = await import('./modules/payments/payments.repository.js')
    const { PaymentsService } = await import('./modules/payments/payments.service.js')
    const { PaymentsController } = await import('./modules/payments/payments.controller.js')

    const repo = new PaymentsRepository()
    const service = new PaymentsService(repo)
    const controller = new PaymentsController(service)

    fastify.post('/razorpay', {
      schema: {
        tags: ['Payments'],
        summary: 'Razorpay webhook handler',
      },
      config: {
        rawBody: true,
        rateLimit: false,   // Razorpay retries failed webhooks — don't rate-limit
      },
    }, controller.webhook.bind(controller))
  }, { prefix: '/api/webhook' })

  // ─── HEALTH CHECKS ─────────────────────────────────────
  app.get('/', {
    schema: {
      tags: ['Health'],
      summary: 'Root status endpoint',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            service: { type: 'string' },
            timestamp: { type: 'string' },
            uptime: { type: 'number' },
            health: { type: 'string' },
          },
        },
      },
    },
    config: {
      rateLimit: false,
    },
  }, async () => ({
    status: 'OK',
    service: 'bakaloo-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    health: '/health/ready',
  }))

  app.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Liveness health check',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
            uptime: { type: 'number' },
          },
        },
      },
    },
  }, async () => ({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }))

  app.get('/health/ready', {
    schema: {
      tags: ['Health'],
      summary: 'Readiness health check',
    },
  }, async (request, reply) => {
    const [postgresResult, redisResult] = await Promise.allSettled([
      query('SELECT 1'),
      redis.ping(),
    ])

    const dependencies = {
      postgres: postgresResult.status === 'fulfilled'
        ? { status: 'up' }
        : {
            status: 'down',
            error: postgresResult.reason?.message || 'Unknown PostgreSQL error',
          },
      redis: redisResult.status === 'fulfilled'
        ? { status: 'up' }
        : {
            status: 'down',
            error: redisResult.reason?.message || 'Unknown Redis error',
          },
    }

    const ready = Object.values(dependencies).every(
      (dependency) => dependency.status === 'up'
    )

    if (!ready) {
      request.log.error({ dependencies }, 'Readiness check failed')
      return reply.code(503).send({
        status: 'NOT_READY',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        dependencies,
      })
    }

    return {
      status: 'READY',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dependencies,
    }
  })

  return app
}
