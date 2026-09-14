import { verifyToken } from '../../utils/jwt.js'
import { env } from '../../config/env.js'
import { success, error } from '../../utils/apiResponse.js'
import { WEBVIEW_TOKEN_PURPOSE } from '../nav-buttons/nav-buttons.routes.js'

/**
 * Public identity-resolution endpoint for a WEBVIEW nav-button destination
 * (see nav-buttons.routes.js's POST /webview-token, which mints the token
 * this verifies). A destination page — ours or a third party's — calls this
 * with the token the app appended to its URL to identify the viewer,
 * without ever seeing that customer's real login token. The `purpose`
 * claim is checked so a normal access/refresh token (or the shop-selection
 * temp token, which shares the same signing secret) can never be replayed
 * here as if it were a webview handoff.
 */
export default async function webviewRoutes(fastify) {
  fastify.get('/session', {
    // token MUST be declared: the global ajv removeAdditional:'all'
    // (src/app.js) silently deletes any query param this route doesn't
    // list, before the handler runs — the exact bug class that broke B2B
    // pricing elsewhere this session. Undeclared here, every call would
    // silently lose its token and this endpoint would always 400.
    schema: {
      querystring: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
  }, async (request, reply) => {
    const token = request.query?.token
    if (!token || typeof token !== 'string') {
      return error('Missing token', 400)
    }

    let payload
    try {
      payload = verifyToken(token, env.JWT_ACCESS_SECRET)
    } catch {
      return error('Invalid or expired token', 401)
    }

    if (payload.purpose !== WEBVIEW_TOKEN_PURPOSE) {
      return error('Invalid or expired token', 401)
    }

    return success(
      {
        userId: payload.id,
        name: payload.name,
        b2bStatus: payload.b2bStatus,
      },
      'Session resolved'
    )
  })
}
