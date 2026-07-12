import { AdminTutorialsController } from './tutorials.controller.js'
import {
  tutorialIdSchema, createTutorialSchema, updateTutorialSchema, reorderTutorialsSchema,
} from './tutorials.schema.js'

const ctrl = new AdminTutorialsController()

export default async function adminTutorialRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', ctrl.list)
  fastify.get('/:id', { schema: tutorialIdSchema }, ctrl.getById)
  fastify.post('/', { schema: createTutorialSchema }, ctrl.create)
  fastify.put('/:id', { schema: updateTutorialSchema }, ctrl.update)
  fastify.delete('/:id', { schema: tutorialIdSchema }, ctrl.remove)
  fastify.put('/reorder', { schema: reorderTutorialsSchema }, ctrl.reorder)
}
