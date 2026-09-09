import { SpinWheelController } from './spin-wheel.controller.js'
import { SpinWheelService } from './spin-wheel.service.js'
import { SpinWheelRepository } from './spin-wheel.repository.js'
import {
  configSchema,
  eligibilitySchema,
  spinSchema,
  listPrizesSchema,
  createPrizeSchema,
  updatePrizeSchema,
  deletePrizeSchema,
  reorderPrizesSchema,
  getSettingsSchema,
  updateSettingsSchema,
  listMilestoneRulesSchema,
  createMilestoneRuleSchema,
  updateMilestoneRuleSchema,
  deleteMilestoneRuleSchema,
  grantSpinsSchema,
  listHistorySchema,
} from './spin-wheel.schema.js'

/**
 * Spin & Win routes plugin
 * Prefix: /api/v1/spin-wheel
 *
 * Same shape as cart-milestones.routes.js — customer + admin routes in one
 * module (not split into a separate admin/ sub-module + public shim like
 * banners), since every route here shares one repository/service.
 */
export default async function spinWheelRoutes(fastify) {
  const repository = new SpinWheelRepository()
  const service = new SpinWheelService(repository)
  const controller = new SpinWheelController(service)

  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  // ─── Customer routes ────────────────────────────────────
  fastify.get('/config', {
    schema: configSchema,
    preHandler: [fastify.authenticate],
  }, controller.config.bind(controller))

  fastify.get('/eligibility', {
    schema: eligibilitySchema,
    preHandler: [fastify.authenticate],
  }, controller.eligibility.bind(controller))

  fastify.post('/spin', {
    schema: spinSchema,
    preHandler: [fastify.authenticate],
  }, controller.spin.bind(controller))

  // ─── Admin: prizes ───────────────────────────────────────
  fastify.get('/admin/prizes', {
    schema: listPrizesSchema,
    preHandler: adminAuth,
  }, controller.listPrizes.bind(controller))

  fastify.post('/admin/prizes', {
    schema: createPrizeSchema,
    preHandler: adminAuth,
  }, controller.createPrize.bind(controller))

  fastify.patch('/admin/prizes/:id', {
    schema: updatePrizeSchema,
    preHandler: adminAuth,
  }, controller.updatePrize.bind(controller))

  fastify.delete('/admin/prizes/:id', {
    schema: deletePrizeSchema,
    preHandler: adminAuth,
  }, controller.deletePrize.bind(controller))

  fastify.put('/admin/prizes/reorder', {
    schema: reorderPrizesSchema,
    preHandler: adminAuth,
  }, controller.reorderPrizes.bind(controller))

  // ─── Admin: settings ─────────────────────────────────────
  fastify.get('/admin/settings', {
    schema: getSettingsSchema,
    preHandler: adminAuth,
  }, controller.getSettings.bind(controller))

  fastify.put('/admin/settings', {
    schema: updateSettingsSchema,
    preHandler: adminAuth,
  }, controller.updateSettings.bind(controller))

  // ─── Admin: milestone rules ──────────────────────────────
  fastify.get('/admin/milestones', {
    schema: listMilestoneRulesSchema,
    preHandler: adminAuth,
  }, controller.listMilestoneRules.bind(controller))

  fastify.post('/admin/milestones', {
    schema: createMilestoneRuleSchema,
    preHandler: adminAuth,
  }, controller.createMilestoneRule.bind(controller))

  fastify.patch('/admin/milestones/:id', {
    schema: updateMilestoneRuleSchema,
    preHandler: adminAuth,
  }, controller.updateMilestoneRule.bind(controller))

  fastify.delete('/admin/milestones/:id', {
    schema: deleteMilestoneRuleSchema,
    preHandler: adminAuth,
  }, controller.deleteMilestoneRule.bind(controller))

  // ─── Admin: manual grant + history ───────────────────────
  fastify.post('/admin/grant', {
    schema: grantSpinsSchema,
    preHandler: adminAuth,
  }, controller.grantSpins.bind(controller))

  fastify.get('/admin/history', {
    schema: listHistorySchema,
    preHandler: adminAuth,
  }, controller.listHistory.bind(controller))
}
