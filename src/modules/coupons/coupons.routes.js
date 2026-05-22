import { CouponsController } from './coupons.controller.js'
import { CouponsService } from './coupons.service.js'
import { CouponsRepository } from './coupons.repository.js'
import {
  validateCouponSchema,
  availableCouponsSchema,
  listCouponsAdminSchema,
  createCouponSchema,
  updateCouponSchema,
  deleteCouponSchema,
} from './coupons.schema.js'

/**
 * Coupons routes plugin
 * Prefix: /api/v1/coupons
 */
export default async function couponsRoutes(fastify) {
  const repository = new CouponsRepository()
  const service = new CouponsService(repository)
  const controller = new CouponsController(service)

  // ─── Customer routes (AUTH) ─────────────────────────────

  // POST /validate — Validate coupon for cart
  fastify.post('/validate', {
    schema: validateCouponSchema,
    preHandler: [fastify.authenticate],
  }, controller.validate.bind(controller))

  // GET /available — List available coupons
  fastify.get('/available', {
    schema: availableCouponsSchema,
    preHandler: [fastify.authenticate],
  }, controller.available.bind(controller))

  // ─── Admin routes ───────────────────────────────────────

  // GET / — All coupons [ADMIN]
  fastify.get('/', {
    schema: listCouponsAdminSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.listAll.bind(controller))

  // POST / — Create coupon [ADMIN]
  fastify.post('/', {
    schema: createCouponSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.create.bind(controller))

  // PUT /:id — Update coupon [ADMIN]
  fastify.put('/:id', {
    schema: updateCouponSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.update.bind(controller))

  // DELETE /:id — Delete coupon [ADMIN]
  fastify.delete('/:id', {
    schema: deleteCouponSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.delete.bind(controller))
}
