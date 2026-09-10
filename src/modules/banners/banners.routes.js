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

  fastify.get('/', { preHandler: [tryAttachUser] }, async (request, reply) => {
    const audience = resolveEffectiveAudience(request)
    const banners = await svc.getActiveForStoreStatus(audience)
    return success(banners, 'Active banners fetched')
  })
}
