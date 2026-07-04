import { StoreStatusController } from './store-status.controller.js'
import { StoreStatusService } from './store-status.service.js'
import { StoreStatusRepository } from './store-status.repository.js'

const repository = new StoreStatusRepository()
const service = new StoreStatusService(repository)
const controller = new StoreStatusController(service)

/** Shared service instance other modules (billing, orders, banners) import. */
export function getStoreStatusService() {
  return service
}

/**
 * Public store-status route.
 * Prefix: /api/v1/store
 *
 *   GET /status — { isOpen, source, reason }, no auth required.
 */
export async function publicStoreStatusRoutes(fastify) {
  fastify.get('/status', {
    schema: {
      tags: ['Store Status'],
      summary: 'Get whether the storefront is currently open',
    },
  }, controller.publicStatus.bind(controller))
}

/**
 * Admin store-status routes.
 * Prefix: /api/v1/admin/store-status
 *
 *   GET /            — full detail incl. weekly hours
 *   PUT /override     — set/clear the manual OPEN/CLOSED override
 *   PUT /weekly-hours  — bulk-replace the weekly schedule
 */
export async function adminStoreStatusRoutes(fastify) {
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', {
    schema: { tags: ['Store Status'], summary: 'Get full store status (admin)' },
    preHandler: adminAuth,
  }, controller.adminStatus.bind(controller))

  fastify.put('/override', {
    schema: { tags: ['Store Status'], summary: 'Set or clear the manual open/closed override' },
    preHandler: adminAuth,
  }, controller.setOverride.bind(controller))

  fastify.put('/weekly-hours', {
    schema: { tags: ['Store Status'], summary: 'Update the weekly hours schedule' },
    preHandler: adminAuth,
  }, controller.updateWeeklyHours.bind(controller))
}
