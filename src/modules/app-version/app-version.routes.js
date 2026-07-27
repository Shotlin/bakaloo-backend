import { AppVersionController } from './app-version.controller.js'
import { AppVersionService } from './app-version.service.js'
import { AppVersionRepository } from './app-version.repository.js'

const repository = new AppVersionRepository()
const service = new AppVersionService(repository)
const controller = new AppVersionController(service)

/**
 * Public app-version route.
 * Prefix: /api/v1/app
 *
 *   GET /version-check?platform=android&buildNumber=27 — no auth required.
 *     Checked at app startup, before login — must never require a session.
 */
export async function publicAppVersionRoutes(fastify) {
  fastify.get('/version-check', {
    schema: {
      tags: ['App Version'],
      summary: 'Check whether this app build must (force) or should (soft) update',
    },
  }, controller.check.bind(controller))
}

/**
 * Admin app-version routes.
 * Prefix: /api/v1/admin/app-versions
 *
 *   GET /            — current config for both platforms
 *   PUT /:platform    — update min/latest build + message + store url
 */
export async function adminAppVersionRoutes(fastify) {
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', {
    schema: { tags: ['App Version'], summary: 'Get app version config (admin)' },
    preHandler: adminAuth,
  }, controller.listAll.bind(controller))

  fastify.put('/:platform', {
    schema: { tags: ['App Version'], summary: 'Update app version config for a platform' },
    preHandler: adminAuth,
  }, controller.update.bind(controller))
}
