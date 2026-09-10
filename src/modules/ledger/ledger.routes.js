import { LedgerController } from './ledger.controller.js'
import { LedgerService } from './ledger.service.js'
import { LedgerRepository } from './ledger.repository.js'

/**
 * Ledger routes plugin (customer-facing).
 * Prefix: /api/v1/ledger
 *
 * Admin setup/limits/status lives separately at /api/v1/admin/ledger
 * (see modules/admin/ledger), sharing this same repository.
 */
export default async function ledgerRoutes(fastify) {
  const repository = new LedgerRepository()
  const service = new LedgerService(repository)
  const controller = new LedgerController(service)

  fastify.get(
    '/me',
    {
      schema: {
        tags: ['Ledger'],
        summary: 'Get my B2B ledger account (balance, limits, status)',
        security: [{ bearerAuth: [] }],
      },
      preHandler: [fastify.authenticate],
    },
    controller.getMine.bind(controller)
  )

  fastify.get(
    '/me/transactions',
    {
      schema: {
        tags: ['Ledger'],
        summary: 'Get my B2B ledger transaction history',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', default: 1 },
            limit: { type: 'integer', default: 20, maximum: 100 },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    controller.getMyTransactions.bind(controller)
  )

  fastify.get(
    '/me/cycles',
    {
      schema: {
        tags: ['Ledger'],
        summary: 'Get my B2B ledger billing cycle history',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', default: 1 },
            limit: { type: 'integer', default: 20, maximum: 100 },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    controller.getMyCycles.bind(controller)
  )

  fastify.post(
    '/pay',
    {
      schema: {
        tags: ['Ledger'],
        summary: 'Pay for an already-placed order from the B2B credit line',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['orderId'],
          properties: {
            orderId: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    controller.payFromLedger.bind(controller)
  )
}
