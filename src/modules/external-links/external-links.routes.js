import { ExternalLinksService } from './external-links.service.js'
import { success, error } from '../../utils/apiResponse.js'

/**
 * External Links routes plugin.
 * Prefix: /api/v1/external-links
 *
 *   GET /       — public: the two destination URLs (blank = not configured
 *                 = button hidden). No auth required; the customer app
 *                 reads this before a viewer necessarily has a session.
 *   PUT /admin  — admin-only: update either URL. Same body shape as GET
 *                 returns, so the dashboard can round-trip its own state.
 */
export default async function externalLinksRoutes(fastify) {
  const service = new ExternalLinksService()

  fastify.get('/', async (request, reply) => {
    const config = await service.getConfig()
    return success(config, 'External links fetched')
  })

  fastify.put('/admin', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          businessTransactionUrl: { type: 'string', maxLength: 2000 },
          gamesUrl: { type: 'string', maxLength: 2000 },
        },
      },
    },
  }, async (request, reply) => {
    const result = await service.updateConfig(request.body || {})
    if (!result.success) {
      reply.code(400)
      return error(result.message, 'EXTERNAL_LINKS_INVALID')
    }
    return success(result.data, 'External links updated')
  })
}
