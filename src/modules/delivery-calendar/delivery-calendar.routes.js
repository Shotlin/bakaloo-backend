import { DeliveryCalendarController } from './delivery-calendar.controller.js'
import { DeliveryCalendarService } from './delivery-calendar.service.js'
import { DeliveryCalendarRepository } from './delivery-calendar.repository.js'

const repository = new DeliveryCalendarRepository()
const service = new DeliveryCalendarService(repository)
const controller = new DeliveryCalendarController(service)

/** Shared service instance other modules (orders.service.js) import. */
export function getDeliveryCalendarService() {
  return service
}

/**
 * Public delivery-calendar route.
 * Prefix: /api/v1/delivery
 *
 *   GET /slots?days= — replaces the old hardcoded 7-day generator
 *   (orders/delivery-slots.routes.js, removed) at the exact same path and
 *   response shape, so mobile needs zero changes. `days` now genuinely
 *   supports up to 60 (was capped at 7).
 */
export async function publicDeliveryCalendarRoutes(fastify) {
  fastify.get('/slots', {
    schema: {
      tags: ['Delivery'],
      summary: 'Get available delivery time slots',
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 60, default: 7 },
        },
      },
    },
    preHandler: [fastify.authenticate],
  }, controller.publicSlots.bind(controller))
}

/**
 * Admin delivery-calendar routes.
 * Prefix: /api/v1/admin/delivery-calendar
 */
export async function adminDeliveryCalendarRoutes(fastify) {
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/template', {
    schema: { tags: ['Delivery Calendar'], summary: 'Get the weekly template' },
    preHandler: adminAuth,
  }, controller.getTemplate.bind(controller))

  fastify.put('/template', {
    schema: { tags: ['Delivery Calendar'], summary: 'Replace the weekly template' },
    preHandler: adminAuth,
  }, controller.putTemplate.bind(controller))

  fastify.get('/days', {
    schema: { tags: ['Delivery Calendar'], summary: 'Get calendar days in a date range' },
    preHandler: adminAuth,
  }, controller.getDays.bind(controller))

  fastify.patch('/days/:date', {
    schema: { tags: ['Delivery Calendar'], summary: 'Override a specific date' },
    preHandler: adminAuth,
  }, controller.patchDay.bind(controller))

  fastify.post('/generate', {
    schema: { tags: ['Delivery Calendar'], summary: 'Materialize the calendar forward from the template' },
    preHandler: adminAuth,
  }, controller.generate.bind(controller))
}
