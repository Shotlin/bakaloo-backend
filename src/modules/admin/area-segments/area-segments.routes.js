import { AreaSegmentsController } from './area-segments.controller.js'
import { AreaSegmentsService } from './area-segments.service.js'
import { AreaSegmentsRepository } from './area-segments.repository.js'
import {
  listSegmentsSchema,
  segmentIdSchema,
  createSegmentSchema,
  updateSegmentSchema,
  listAddressesSchema,
  addAddressSchema,
  removeAddressSchema,
  getActiveOrdersSchema,
  searchCandidatesSchema,
  getCustomerAddressesSchema,
} from './area-segments.schema.js'

/**
 * Area Segments routes plugin
 * Mounted at /api/v1/admin/area-segments (see admin.routes.js)
 */
export default async function adminAreaSegmentsRoutes(fastify) {
  const repository = new AreaSegmentsRepository()
  const service = new AreaSegmentsService(repository)
  const controller = new AreaSegmentsController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listSegmentsSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: createSegmentSchema }, controller.create.bind(controller))
  fastify.get('/search-candidates', { schema: searchCandidatesSchema }, controller.searchCandidates.bind(controller))
  fastify.get('/customers/:userId/addresses', { schema: getCustomerAddressesSchema }, controller.getCustomerAddresses.bind(controller))

  fastify.get('/:id', { schema: segmentIdSchema }, controller.getDetail.bind(controller))
  fastify.patch('/:id', { schema: updateSegmentSchema }, controller.update.bind(controller))
  fastify.delete('/:id', { schema: segmentIdSchema }, controller.delete.bind(controller))

  fastify.get('/:id/addresses', { schema: listAddressesSchema }, controller.getAddresses.bind(controller))
  fastify.post('/:id/addresses', { schema: addAddressSchema }, controller.addAddress.bind(controller))
  fastify.delete('/:id/addresses/:addressId', { schema: removeAddressSchema }, controller.removeAddress.bind(controller))

  fastify.get('/:id/active-orders', { schema: getActiveOrdersSchema }, controller.getActiveOrders.bind(controller))
}
