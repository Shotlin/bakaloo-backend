const APPROVED_AND_ENABLED = (b2b) => !!b2b && b2b.status === 'APPROVED' && b2b.enabled === true

/**
 * Resolves whether a request should see wholesale pricing.
 *
 * Wholesale is only ever granted when BOTH sides agree: the client
 * explicitly asks for it (via `wantsWholesale`) AND the account's live,
 * server-verified B2B status (populated by `fastify.authenticate` /
 * `fastify.optionalAuth` on `request.auth.b2b`) is an approved, enabled
 * business account. A client asking for wholesale on a B2C account (or an
 * unauthenticated request) is silently given retail — never trusted from
 * the client alone.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {boolean} wantsWholesale - client-supplied hint (e.g. a `priceMode=wholesale` query param)
 * @returns {'wholesale' | 'retail'}
 */
export function resolveEffectivePriceMode(request, wantsWholesale) {
  if (!wantsWholesale) return 'retail'
  return APPROVED_AND_ENABLED(request.auth?.b2b) ? 'wholesale' : 'retail'
}

/**
 * Resolves which storefront audience a request belongs to, purely from the
 * account's live B2B status — never from a client-supplied hint. Unlike
 * price mode (which a B2B customer can still browse retail), audience
 * membership is not something a viewer opts into per-request.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {'B2B' | 'B2C'}
 */
export function resolveEffectiveAudience(request) {
  return APPROVED_AND_ENABLED(request.auth?.b2b) ? 'B2B' : 'B2C'
}
