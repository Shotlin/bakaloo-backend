import { PurchaseLimitsController } from './purchase-limits.controller.js'
import { PurchaseLimitsService } from './purchase-limits.service.js'
import { PurchaseLimitsRepository } from './purchase-limits.repository.js'
import {
  myStatusSchema,
  listRulesSchema,
  createRuleSchema,
  updateRuleSchema,
  toggleRuleSchema,
  deleteRuleSchema,
} from './purchase-limits.schema.js'

/**
 * Purchase Limits routes plugin
 * Prefix: /api/v1/purchase-limits
 */
export default async function purchaseLimitsRoutes(fastify) {
  const repository = new PurchaseLimitsRepository()
  const service = new PurchaseLimitsService(repository)
  const controller = new PurchaseLimitsController(service)

  // ─── Customer route ─────────────────────────────────────
  fastify.get('/my-status', {
    schema: myStatusSchema,
    preHandler: [fastify.authenticate],
  }, controller.myStatus.bind(controller))

  // ─── Admin routes ────────────────────────────────────────
  fastify.get('/', {
    schema: listRulesSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.list.bind(controller))

  fastify.post('/', {
    schema: createRuleSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.create.bind(controller))

  fastify.patch('/:id', {
    schema: updateRuleSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.update.bind(controller))

  fastify.patch('/:id/toggle', {
    schema: toggleRuleSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.toggle.bind(controller))

  fastify.delete('/:id', {
    schema: deleteRuleSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.remove.bind(controller))
}
