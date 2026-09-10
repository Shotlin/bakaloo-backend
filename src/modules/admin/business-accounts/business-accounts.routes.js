import { BusinessAccountsRepository } from '../../business-accounts/business-accounts.repository.js'
import { AdminBusinessAccountsService } from './business-accounts.service.js'
import { AdminBusinessAccountsController } from './business-accounts.controller.js'
import {
  listBusinessAccountsSchema, businessAccountDetailSchema,
  approveBusinessAccountSchema, rejectBusinessAccountSchema,
} from './business-accounts.schema.js'

/**
 * Admin business accounts routes
 * Prefix: /api/v1/admin/business-accounts
 */
export default async function adminBusinessAccountsRoutes(fastify) {
  const repo = new BusinessAccountsRepository()
  const service = new AdminBusinessAccountsService(repo, fastify)
  const ctrl = new AdminBusinessAccountsController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', { schema: listBusinessAccountsSchema, preHandler: adminAuth }, ctrl.findAll.bind(ctrl))
  fastify.get('/:id', { schema: businessAccountDetailSchema, preHandler: adminAuth }, ctrl.findById.bind(ctrl))
  fastify.post('/:id/approve', { schema: approveBusinessAccountSchema, preHandler: adminAuth }, ctrl.approve.bind(ctrl))
  fastify.post('/:id/reject', { schema: rejectBusinessAccountSchema, preHandler: adminAuth }, ctrl.reject.bind(ctrl))
}
