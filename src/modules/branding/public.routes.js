import { PublicBrandingController } from './public.controller.js'

const ctrl = new PublicBrandingController()

export default async function publicBrandingRoutes(fastify) {
  // NO auth hook — this is a public endpoint, fetched at app cold start.
  fastify.get('/', {
    schema: {
      tags: ['Branding'],
      summary: 'Get app-wide branding (splash image + logo) — public, no auth',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                splashImageUrl: { type: ['string', 'null'] },
                logoImageUrl: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  }, ctrl.getBranding.bind(ctrl))
}
