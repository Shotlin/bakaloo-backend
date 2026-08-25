import { AdminLegalPagesController } from './legal-pages.controller.js'
import { legalPageSlugSchema, updateLegalPageSchema } from './legal-pages.schema.js'

const ctrl = new AdminLegalPagesController()

export default async function adminLegalPagesRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', ctrl.list)
  fastify.get('/:slug', { schema: legalPageSlugSchema }, ctrl.getBySlug)
  fastify.put('/:slug', { schema: updateLegalPageSchema }, ctrl.update)
}
