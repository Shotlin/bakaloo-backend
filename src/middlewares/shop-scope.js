import { cacheGet, cacheSet, cacheDel } from '../utils/cache.js'
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { ROLES } from '../constants/roles.js'

/**
 * Shop scope middleware — derives `request.shopId` from the authenticated user's
 * JWT payload (shop staff) or the `X-Shop-Id` header (platform Super Admin),
 * and rejects requests where the caller's scope does not match the target
 * resource's shop_id (Requirements 2.9, 13.6).
 *
 * Requirements: 2.7, 2.9, 2.10, 2.11, 13.5, 13.6, 13.7, 13.8, 13.9
 *
 * Resolution rules (`requireShopScope`):
 *   1. Shop-scoped JWT (request.user.shopId present)
 *      → validate the staff record is still active (Redis cache, TTL 300s,
 *        falling back to DB on miss); reject 403 STAFF_INACTIVE if not.
 *      → set request.shopId = JWT shopId
 *
 *   2. Platform ADMIN (Super Admin, JWT role === 'ADMIN')
 *      → if X-Shop-Id header present:
 *          - must be a UUID → 400 INVALID_SHOP_ID otherwise
 *          - shop must exist, is_active=true, deleted_at IS NULL → 400 INVALID_SHOP_ID
 *          - set request.shopId to the header value
 *      → otherwise allow with request.shopId = null (platform-wide ops)
 *
 *   3. Non-staff non-admin users (e.g., CUSTOMER, RIDER)
 *      → set request.shopId = null
 *      → if `requireShop: true`, reject 403 SHOP_SCOPE_REQUIRED
 *
 * Cross-shop enforcement (`requireShopMatch`):
 *   For shop-owned resources, compare the caller's effective shop scope to the
 *   resource's shop_id. Super Admins (role === 'ADMIN') always pass. Any other
 *   role whose JWT shop_id differs from the resource shop_id is rejected with
 *   403 SHOP_SCOPE_MISMATCH.
 */

const STAFF_ACTIVE_CACHE_PREFIX = 'bakaloo:staff-active:v1:'
const STAFF_ACTIVE_TTL_SECONDS = 300
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Compute the cache key for a (user_id, shop_id) staff-active flag.
 * Exported so other modules (shop-staff service) can invalidate consistently.
 * @param {string} userId
 * @param {string} shopId
 * @returns {string}
 */
export function staffActiveCacheKey(userId, shopId) {
  return `${STAFF_ACTIVE_CACHE_PREFIX}${userId}:${shopId}`
}

/**
 * Invalidate the staff-active cache for a user/shop pair.
 * Called by shop-staff service when a staff record's is_active changes
 * or the record is soft-deleted (Requirement 2.11).
 * @param {string} userId
 * @param {string} shopId
 */
export async function invalidateStaffActiveCache(userId, shopId) {
  if (!userId || !shopId) return
  await cacheDel(staffActiveCacheKey(userId, shopId))
}

/**
 * Check whether a (user_id, shop_id) staff record is active.
 * Cache-through with TTL 300s; on miss queries the DB.
 * Joined with shops to also reject when the parent shop is deactivated/deleted.
 *
 * @param {string} userId
 * @param {string} shopId
 * @returns {Promise<boolean>}
 */
async function isStaffActive(userId, shopId) {
  const key = staffActiveCacheKey(userId, shopId)
  const cached = await cacheGet(key)
  if (cached !== null && cached !== undefined) {
    return cached === true
  }

  const { rows } = await query(
    `SELECT ss.id
       FROM shop_staff ss
       JOIN shops s ON s.id = ss.shop_id
      WHERE ss.user_id = $1
        AND ss.shop_id = $2
        AND ss.is_active = true
        AND ss.deleted_at IS NULL
        AND s.is_active = true
        AND s.deleted_at IS NULL
      LIMIT 1`,
    [userId, shopId]
  )
  const active = rows.length > 0
  await cacheSet(key, active, STAFF_ACTIVE_TTL_SECONDS)
  return active
}

/**
 * Validate that a shop_id from the X-Shop-Id header refers to an active shop.
 * @param {string} shopId
 * @returns {Promise<boolean>}
 */
async function isShopActive(shopId) {
  const { rows } = await query(
    `SELECT id FROM shops
      WHERE id = $1 AND is_active = true AND deleted_at IS NULL
      LIMIT 1`,
    [shopId]
  )
  return rows.length > 0
}

/**
 * Fastify preHandler factory — derive and attach `request.shopId`.
 *
 * Must be used AFTER `fastify.authenticate` so `request.user` is populated.
 *
 * @param {object} [options]
 * @param {boolean} [options.requireShop=false] - If true, reject when no shop
 *   scope can be derived (e.g., a customer hitting a shop-scoped endpoint).
 * @returns {import('fastify').preHandlerHookHandler}
 */
export function requireShopScope(options = {}) {
  const requireShop = options.requireShop === true

  return async function shopScopePreHandler(request, reply) {
    const user = request.user
    if (!user || !user.id) {
      return reply.code(401).send({
        success: false,
        message: 'Unauthorized — authentication required',
        code: 'UNAUTHORIZED',
      })
    }

    const tokenShopId = user.shopId || user.shop_id || null

    // ── 1. Shop-scoped staff JWT ────────────────────────────────
    if (tokenShopId) {
      const active = await isStaffActive(user.id, tokenShopId)
      if (!active) {
        logger.warn(
          {
            userId: user.id,
            shopId: tokenShopId,
            action: 'shop_scope_rejected_inactive_staff',
          },
          'Rejected request — staff record inactive'
        )
        return reply.code(403).send({
          success: false,
          message: 'Shop assignment is no longer active',
          code: 'STAFF_INACTIVE',
        })
      }
      request.shopId = tokenShopId
      return
    }

    // ── 2. Platform Super Admin with optional X-Shop-Id ─────────
    if (user.role === ROLES.ADMIN) {
      const headerShopId = request.headers['x-shop-id']
      if (headerShopId) {
        const candidate = String(headerShopId).trim()
        if (!UUID_REGEX.test(candidate)) {
          return reply.code(400).send({
            success: false,
            message: 'X-Shop-Id header must be a valid UUID',
            code: 'INVALID_SHOP_ID',
          })
        }
        const exists = await isShopActive(candidate)
        if (!exists) {
          return reply.code(400).send({
            success: false,
            message: 'X-Shop-Id refers to an unknown or inactive shop',
            code: 'INVALID_SHOP_ID',
          })
        }
        request.shopId = candidate
        return
      }
      request.shopId = null
      return
    }

    // ── 3. Non-staff non-admin (customers, riders) ──────────────
    request.shopId = null

    if (requireShop) {
      return reply.code(403).send({
        success: false,
        message: 'Forbidden — shop-scoped access required',
        code: 'SHOP_SCOPE_REQUIRED',
      })
    }
  }
}

/**
 * Pure decision function for cross-shop access (Requirements 2.9, 13.6).
 *
 * Inputs are intentionally primitive (no Fastify request/reply) so the
 * decision can be unit- and property-tested in isolation, and reused from
 * both Fastify preHandlers and service layer guards.
 *
 * @param {object} args
 * @param {string} args.role - JWT user role (e.g., 'ADMIN', 'CUSTOMER',
 *   'RIDER'). Shop staff carry their platform role here, not their shop role.
 * @param {string|null|undefined} args.jwtShopId - shop_id derived from the JWT
 *   (or null for super admins / non-staff).
 * @param {string|null|undefined} args.resourceShopId - shop_id of the target
 *   resource being accessed (e.g., shop_products.shop_id, orders.shop_id).
 * @returns {{allowed: true} | {allowed: false, status: number, code: string, message: string}}
 */
export function assertShopMatch({ role, jwtShopId, resourceShopId }) {
  // Super Admins bypass shop-scope checks entirely (Requirement 2.10, 13.7).
  if (role === ROLES.ADMIN) {
    return { allowed: true }
  }

  // Resource shop_id must be present for the comparison to be meaningful.
  // A missing resource shop_id is treated as a configuration error and
  // rejected the same way as a mismatch — fail closed.
  if (!resourceShopId) {
    return {
      allowed: false,
      status: 403,
      code: 'SHOP_SCOPE_MISMATCH',
      message: 'Forbidden — resource is not scoped to your shop',
    }
  }

  // Non-admin caller without a shop-scoped JWT cannot access shop resources.
  if (!jwtShopId) {
    return {
      allowed: false,
      status: 403,
      code: 'SHOP_SCOPE_MISMATCH',
      message: 'Forbidden — resource is not scoped to your shop',
    }
  }

  if (jwtShopId !== resourceShopId) {
    return {
      allowed: false,
      status: 403,
      code: 'SHOP_SCOPE_MISMATCH',
      message: 'Forbidden — resource is not scoped to your shop',
    }
  }

  return { allowed: true }
}

/**
 * Fastify preHandler factory enforcing cross-shop access (Property 17).
 *
 * Must run AFTER `requireShopScope` so `request.shopId` is populated for
 * staff JWTs and `request.user.role` is available.
 *
 * @param {(request: import('fastify').FastifyRequest) => (string|null|undefined|Promise<string|null|undefined>)} getResourceShopId
 *   Callback that returns the target resource's shop_id, typically loaded
 *   from the route param's owning row. Must be a parameterized query in the
 *   caller — this middleware does not execute SQL itself.
 * @returns {import('fastify').preHandlerHookHandler}
 */
export function requireShopMatch(getResourceShopId) {
  if (typeof getResourceShopId !== 'function') {
    throw new TypeError(
      'requireShopMatch(getResourceShopId): callback must be a function'
    )
  }

  return async function shopMatchPreHandler(request, reply) {
    const user = request.user
    if (!user || !user.id) {
      return reply.code(401).send({
        success: false,
        message: 'Unauthorized — authentication required',
        code: 'UNAUTHORIZED',
      })
    }

    const resourceShopId = await getResourceShopId(request)
    const decision = assertShopMatch({
      role: user.role,
      jwtShopId: request.shopId ?? user.shopId ?? user.shop_id ?? null,
      resourceShopId,
    })

    if (!decision.allowed) {
      logger.warn(
        {
          userId: user.id,
          jwtShopId: request.shopId ?? null,
          resourceShopId: resourceShopId ?? null,
          action: 'shop_scope_mismatch_rejected',
        },
        'Rejected request — JWT shop_id does not match resource shop_id'
      )
      return reply.code(decision.status).send({
        success: false,
        message: decision.message,
        code: decision.code,
      })
    }
  }
}
