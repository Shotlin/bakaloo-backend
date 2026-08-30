import { OlaMapsSettingsController } from './ola-maps-settings.controller.js'
import { OlaMapsSettingsService } from './ola-maps-settings.service.js'
import {
  getSettingsSchema,
  testSettingsSchema,
  updateSettingsSchema,
} from './ola-maps-settings.schema.js'

/**
 * Ola Maps settings admin routes plugin.
 * Prefix: /api/v1/admin/ola-maps-settings
 * All routes require admin auth.
 */
export default async function olaMapsSettingsRoutes(fastify) {
  const service = new OlaMapsSettingsService()
  const controller = new OlaMapsSettingsController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', {
    schema: getSettingsSchema,
    preHandler: adminAuth,
  }, controller.get.bind(controller))

  fastify.post('/test', {
    schema: testSettingsSchema,
    preHandler: adminAuth,
  }, controller.test.bind(controller))

  fastify.put('/', {
    schema: updateSettingsSchema,
    preHandler: adminAuth,
  }, controller.save.bind(controller))
}
