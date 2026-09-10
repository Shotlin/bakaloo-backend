import { BusinessAccountsController } from './business-accounts.controller.js'
import { BusinessAccountsService } from './business-accounts.service.js'
import { BusinessAccountsRepository } from './business-accounts.repository.js'

/**
 * Business Accounts routes plugin (customer-facing).
 * Prefix: /api/v1/business-accounts
 *
 * Admin approve/reject/list lives separately at
 * /api/v1/admin/business-accounts (see modules/admin/business-accounts),
 * sharing this same repository.
 */
export default async function businessAccountsRoutes(fastify) {
  const repository = new BusinessAccountsRepository()
  const service = new BusinessAccountsService(repository)
  const controller = new BusinessAccountsController(service)

  fastify.get(
    '/me',
    {
      schema: {
        tags: ['Business Accounts'],
        summary: 'Get my business account application/status',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [fastify.authenticate],
    },
    controller.getMine.bind(controller)
  )

  fastify.post(
    '/apply',
    {
      schema: {
        tags: ['Business Accounts'],
        summary: 'Apply for a business (B2B) account',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
        },
      },
    },
    controller.apply.bind(controller)
  )

  fastify.patch(
    '/me/toggle',
    {
      schema: {
        tags: ['Business Accounts'],
        summary: 'Enable or disable B2B mode (only once APPROVED)',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [fastify.authenticate],
    },
    controller.toggle.bind(controller)
  )
}
