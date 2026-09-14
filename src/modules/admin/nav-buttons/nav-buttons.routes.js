import { AdminNavButtonsController } from './nav-buttons.controller.js'
import {
  navButtonIdSchema, createNavButtonSchema, updateNavButtonSchema, reorderNavButtonsSchema,
} from './nav-buttons.schema.js'

const ctrl = new AdminNavButtonsController()

export default async function adminNavButtonRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', ctrl.list)
  fastify.get('/:id', { schema: navButtonIdSchema }, ctrl.getById)
  fastify.post('/', { schema: createNavButtonSchema }, ctrl.create)
  fastify.put('/:id', { schema: updateNavButtonSchema }, ctrl.update)
  fastify.delete('/:id', { schema: navButtonIdSchema }, ctrl.remove)
  fastify.put('/reorder', { schema: reorderNavButtonsSchema }, ctrl.reorder)
}
