import { RefundRequestsController } from './refund-requests.controller.js'
import { RefundRequestsService } from './refund-requests.service.js'
import { RefundRequestsRepository } from './refund-requests.repository.js'
import {
  createRefundRequestSchema,
  getMyRefundRequestsSchema,
  getRefundRequestByOrderSchema,
  cancelRefundRequestSchema,
} from './refund-requests.schema.js'

/**
 * Refund requests routes plugin
 * Prefix: /api/v1/refund-requests
 */
export default async function refundRequestsRoutes(fastify) {
  const repository = new RefundRequestsRepository()
  const service = new RefundRequestsService(repository, fastify)
  const controller = new RefundRequestsController(service)

  fastify.post('/', {
    schema: createRefundRequestSchema,
    preHandler: [fastify.authenticate],
  }, controller.createRequest.bind(controller))

  fastify.get('/', {
    schema: getMyRefundRequestsSchema,
    preHandler: [fastify.authenticate],
  }, controller.getMyRequests.bind(controller))

  fastify.get('/order/:orderId', {
    schema: getRefundRequestByOrderSchema,
    preHandler: [fastify.authenticate],
  }, controller.getByOrder.bind(controller))

  fastify.post('/:id/cancel', {
    schema: cancelRefundRequestSchema,
    preHandler: [fastify.authenticate],
  }, controller.cancelRequest.bind(controller))
}
