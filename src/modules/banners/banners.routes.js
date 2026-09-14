import { AdminBannersService } from '../admin/banners/banners.service.js'
import { success } from '../../utils/apiResponse.js'
import { resolveEffectiveAudience } from '../../utils/price-mode.js'

const svc = new AdminBannersService()

export default async function bannerRoutes(fastify) {
  // Best-effort JWT verification — see themes/public.routes.js's identical
  // tryAttachUser for the full rationale. Never rejects; this stays a
  // public/anonymous-friendly endpoint either way.
  const tryAttachUser = async (request) => {
    if (typeof fastify.optionalAuth === 'function') {
      try {
        await fastify.optionalAuth(request)
      } catch {
        /* anonymous fallback */
      }
      return
    }
    try {
      await request.jwtVerify()
    } catch {
      /* anonymous fallback */
    }
  }

  fastify.get('/', {
    // placement MUST be declared here: the global ajv removeAdditional:'all'
    // (src/app.js) silently strips any query param this route doesn't
    // list, before the handler ever sees it — exactly the bug class that
    // caused the B2B/wholesale pricing split earlier in products.schema.js.
    // Omitting it here would make every request fall back to 'HOME' no
    // matter what the caller actually asked for.
    schema: {
      querystring: {
        type: 'object',
        properties: {
          placement: { type: 'string', enum: ['HOME', 'PROFILE'], default: 'HOME' },
        },
      },
    },
    preHandler: [tryAttachUser],
  }, async (request, reply) => {
    const audience = resolveEffectiveAudience(request)
    const placement = request.query?.placement === 'PROFILE' ? 'PROFILE' : 'HOME'
    const userId = request.user?.id || null
    const banners = await svc.getActiveForStoreStatus(audience, placement, userId)
    return success(banners, 'Active banners fetched')
  })
}
