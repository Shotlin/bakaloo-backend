import fp from 'fastify-plugin'
import { env } from '../config/env.js'

/**
 * Global error handler plugin
 * Maps known errors to proper HTTP responses
 * Hides stack traces in production
 */
async function errorHandlerPlugin(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const { statusCode = 500, message, validation, code } = error

    // Fastify validation errors (JSON Schema)
    if (validation) {
      return reply.code(400).send({
        success: false,
        message: 'Validation error',
        code: 'VALIDATION_ERROR',
        errors: validation.map((v) => ({
          field: v.instancePath?.replace('/', '') || v.params?.missingProperty,
          message: v.message,
        })),
      })
    }

    // Rate-limit errors — pass through with 429
    if (statusCode === 429 || code === 'FST_RATE_LIMIT_EXCEEDED') {
      return reply.code(429).send({
        success: false,
        message: message || 'Rate limit exceeded',
        code: 'RATE_LIMIT_EXCEEDED',
      })
    }

    // Known HTTP errors
    if (statusCode < 500) {
      return reply.code(statusCode).send({
        success: false,
        message,
        code: code || 'ERROR',
      })
    }

    // 500 — Internal server error
    request.log.error({ err: error }, 'Internal server error')

    const response = {
      success: false,
      message: env.NODE_ENV === 'production'
        ? 'Internal server error'
        : message,
      code: 'INTERNAL_ERROR',
    }

    if (env.NODE_ENV !== 'production') {
      response.stack = error.stack
    }

    return reply.code(500).send(response)
  })

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      success: false,
      message: `Route ${request.method} ${request.url} not found`,
      code: 'NOT_FOUND',
    })
  })
}

export default fp(errorHandlerPlugin, { name: 'error-handler' })
