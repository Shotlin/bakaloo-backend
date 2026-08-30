import { AdminRefundRequestsRepository } from './refund-requests.repository.js'
import { AdminRefundRequestsService } from './refund-requests.service.js'
import { AdminRefundRequestsController } from './refund-requests.controller.js'
import {
  listRefundRequestsSchema, refundRequestDetailSchema,
  approveRefundRequestSchema, rejectRefundRequestSchema,
} from './refund-requests.schema.js'

/**
 * Admin refund requests routes
 * Prefix: /api/v1/admin/refund-requests
 */
export default async function adminRefundRequestsRoutes(fastify) {
  const repo = new AdminRefundRequestsRepository()
  const service = new AdminRefundRequestsService(repo, fastify)
  const ctrl = new AdminRefundRequestsController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', { schema: listRefundRequestsSchema, preHandler: adminAuth }, ctrl.findAll.bind(ctrl))
  fastify.get('/:id', { schema: refundRequestDetailSchema, preHandler: adminAuth }, ctrl.findById.bind(ctrl))
  fastify.post('/:id/approve', { schema: approveRefundRequestSchema, preHandler: adminAuth }, ctrl.approve.bind(ctrl))
  fastify.post('/:id/reject', { schema: rejectRefundRequestSchema, preHandler: adminAuth }, ctrl.reject.bind(ctrl))
}
