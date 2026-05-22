import { buildApp } from './app.js'
import { env } from './config/env.js'
import { testConnection, closePool } from './config/database.js'
import { closeRedis } from './config/redis.js'
import { logger } from './config/logger.js'

const start = async () => {
  try {
    // Test database connection before starting
    await testConnection()

    // Build Fastify app
    const app = await buildApp()

    // Start listening
    await app.listen({ port: env.PORT, host: env.HOST })

    logger.info(`🚀 ${env.APP_NAME} running on http://${env.HOST}:${env.PORT}`)
    if (env.ENABLE_SWAGGER) {
      logger.info(`📖 Swagger docs at http://localhost:${env.PORT}/documentation`)
    }
    if (app.io) {
      logger.info(`🔌 Socket.IO ready on ws://${env.HOST}:${env.PORT}`)
    }

    // PM2 ready signal
    if (process.send) {
      process.send('ready')
    }

    // ─── GRACEFUL SHUTDOWN ──────────────────────────
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutdown signal received')

      // Close Socket.IO
      if (app.io) {
        app.io.close()
        logger.info('Socket.IO closed')
      }

      // Stop accepting new connections
      await app.close()
      logger.info('Fastify closed')

      // Close database pool
      await closePool()
      logger.info('PostgreSQL pool closed')

      // Close Redis
      await closeRedis()
      logger.info('Redis closed')

      logger.info('Graceful shutdown complete')
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    // Unhandled errors — log and exit
    process.on('unhandledRejection', (err) => {
      logger.fatal({ err }, 'Unhandled rejection')
      process.exit(1)
    })

    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception')
      process.exit(1)
    })
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server')
    process.exit(1)
  }
}

start()
