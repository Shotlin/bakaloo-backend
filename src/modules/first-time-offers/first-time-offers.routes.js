import { FirstTimeOffersController } from './first-time-offers.controller.js'
import { FirstTimeOffersService } from './first-time-offers.service.js'
import { FirstTimeOffersRepository } from './first-time-offers.repository.js'
import {
  eligibleOfferSchema,
  listOffersSchema,
  createOfferSchema,
  updateOfferSchema,
  deleteOfferSchema,
} from './first-time-offers.schema.js'

/**
 * First-Time Offers routes plugin
 * Prefix: /api/v1/first-time-offers
 */
export default async function firstTimeOffersRoutes(fastify) {
  const repository = new FirstTimeOffersRepository()
  const service = new FirstTimeOffersService(repository)
  const controller = new FirstTimeOffersController(service)

  // ─── Customer route ─────────────────────────────────────
  fastify.get('/eligible', {
    schema: eligibleOfferSchema,
    preHandler: [fastify.authenticate],
  }, controller.eligible.bind(controller))

  // ─── Admin routes ────────────────────────────────────────
  fastify.get('/', {
    schema: listOffersSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.listAll.bind(controller))

  fastify.post('/', {
    schema: createOfferSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.create.bind(controller))

  fastify.patch('/:id', {
    schema: updateOfferSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.update.bind(controller))

  fastify.delete('/:id', {
    schema: deleteOfferSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.delete.bind(controller))
}
