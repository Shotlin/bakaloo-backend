import { AdminNavButtonsService } from '../admin/nav-buttons/nav-buttons.service.js'
import { success, error } from '../../utils/apiResponse.js'
import { resolveEffectiveAudience } from '../../utils/price-mode.js'
import { signAccessToken } from '../../utils/jwt.js'
import { query } from '../../config/database.js'

const svc = new AdminNavButtonsService()

// Same expiry as auth.service.js's TEMP_TOKEN_EXPIRY precedent for
// shop-selection tokens — a short-lived, purpose-scoped JWT using the
// same signing utility/secret, just a different marker claim.
const WEBVIEW_TOKEN_EXPIRY = '10m'
export const WEBVIEW_TOKEN_PURPOSE = 'webview_handoff'

export default async function navButtonRoutes(fastify) {
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

  // GET / — the single 5th-nav-button this viewer should see, or null.
  fastify.get('/', { preHandler: [tryAttachUser] }, async (request, reply) => {
    const audience = resolveEffectiveAudience(request)
    const userId = request.user?.id || null
    const button = await svc.getActiveForViewer(audience, userId)
    return success(button, 'Nav button fetched')
  })

  // POST /webview-token — mint a short-lived identity-handoff token for a
  // WEBVIEW-destination button with pass_identity=true. Requires a real
  // login; there's nothing to hand off for an anonymous viewer.
  fastify.post('/webview-token', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { rows: [user] } = await query(
      `SELECT u.name, ba.status AS b2b_status, ba.b2b_enabled
         FROM users u
         LEFT JOIN business_accounts ba ON ba.user_id = u.id
        WHERE u.id = $1`,
      [request.user.id]
    )
    if (!user) return error('User not found', 404)

    const b2bStatus =
      user.b2b_status === 'APPROVED' && user.b2b_enabled ? 'B2B' : 'B2C'

    const token = signAccessToken(
      {
        id: request.user.id,
        name: user.name,
        b2bStatus,
        purpose: WEBVIEW_TOKEN_PURPOSE,
      },
      { expiresIn: WEBVIEW_TOKEN_EXPIRY }
    )
    return success({ token, expiresIn: WEBVIEW_TOKEN_EXPIRY }, 'Webview token issued')
  })
}
