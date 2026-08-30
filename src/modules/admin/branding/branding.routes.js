import { BrandingController } from './branding.controller.js'
import { updateBrandingSchema } from './branding.schema.js'

const ctrl = new BrandingController()

export default async function adminBrandingRoutes(fastify) {
  // IMPORTANT: Use addHook for auth — same pattern as themes.routes.js / banners.routes.js
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', ctrl.get)
  fastify.put('/', { schema: updateBrandingSchema }, ctrl.update)
}
