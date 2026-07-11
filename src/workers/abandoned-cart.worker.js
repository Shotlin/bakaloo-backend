/**
 * Abandoned Cart Sweep Worker
 *
 * Polls every 60s for carts inactive past ABANDONMENT_THRESHOLD_MS (10 min
 * fixed constant — see src/constants/abandonedCart.js), following the same
 * in-process setInterval pattern as payment-expiry.worker.js rather than a
 * BullMQ repeatable job, since this runs inside the main API server and
 * needs no dedicated worker-process infrastructure.
 *
 * Unlike payment-expiry.worker.js's single shared batch transaction, each
 * candidate user here is processed independently (its own try/catch) —
 * abandoned-cart records have no cross-user dependency, so one user's
 * failure must never block or roll back another's.
 *
 * "Recovery" (user resumes shopping) and "conversion" (user completes
 * checkout) are detected immediately elsewhere — CartService and
 * OrdersService respectively — NOT here. This worker only ever creates or
 * refreshes OPEN episodes and expires stale ones.
 */
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { CartRepository } from '../modules/cart/cart.repository.js'
import { CartService } from '../modules/cart/cart.service.js'
import { AbandonedCartsRepository } from '../modules/abandoned-carts/abandoned-carts.repository.js'
import { computeRecoveryPriorityScore } from '../modules/abandoned-carts/priority-score.js'
import {
  ABANDONMENT_THRESHOLD_MS,
  ABANDONED_CART_SWEEP_BATCH_LIMIT,
} from '../constants/abandonedCart.js'

let _intervalHandle = null
let _fastify = null
const POLL_INTERVAL_MS = 60 * 1000 // 1 minute

const cartRepository = new CartRepository()
const cartService = new CartService(cartRepository)
const abandonedCartsRepository = new AbandonedCartsRepository()

/**
 * @param {import('fastify').FastifyInstance} [fastify] Optional — when
 * passed (server.js does, at startup), a newly-DETECTED episode also emits
 * `emitAbandonedCartUpdate` so an open admin dashboard tab updates live
 * instead of only refreshing on next mount/refocus, matching the recovery
 * and conversion signals already pushed elsewhere.
 */
export function startAbandonedCartWorker(fastify) {
  if (_intervalHandle) return
  _fastify = fastify || null

  logger.info('Abandoned cart sweep worker started (polling every 60s)')

  _intervalHandle = setInterval(async () => {
    try {
      await _sweep()
    } catch (err) {
      logger.error({ err: err.message }, 'Abandoned cart worker poll error')
    }
  }, POLL_INTERVAL_MS)

  // Also run immediately on startup
  _sweep().catch((err) =>
    logger.error({ err: err.message }, 'Abandoned cart worker initial poll error')
  )
}

export function stopAbandonedCartWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Abandoned cart sweep worker stopped')
  }
}

async function _sweep() {
  const cutoff = Date.now() - ABANDONMENT_THRESHOLD_MS
  const candidates = await cartRepository.getInactiveUserIds(
    cutoff,
    ABANDONED_CART_SWEEP_BATCH_LIMIT
  )

  if (candidates.length > 0) {
    const excluded = await _excludeUsersWithPendingPayment(
      candidates.map((c) => c.userId)
    )

    for (const { userId, lastActivityMs } of candidates) {
      if (excluded.has(userId)) continue
      try {
        await _processCandidate(userId, lastActivityMs)
      } catch (err) {
        logger.error({ userId, err: err.message }, 'Abandoned cart: failed to process candidate')
      }
    }

    logger.info(
      { candidates: candidates.length, excluded: excluded.size },
      'Abandoned cart sweep tick complete'
    )
  }

  const expiredIds = await abandonedCartsRepository.expireStale()
  if (expiredIds.length > 0) {
    logger.info({ count: expiredIds.length }, 'Abandoned cart: episodes expired')
  }
}

async function _processCandidate(userId, lastActivityMs) {
  const enrichedCart = await cartService.getCart(userId)

  if (!enrichedCart.items || enrichedCart.items.length === 0) {
    // Every line item's shop/product went inactive since the last
    // activity, or the cart is genuinely empty — self-heal so this
    // user isn't reprocessed forever.
    await cartRepository.removeActivity(userId)
    return
  }

  // Priority scoring is only ever used by recordAbandonment() on a first
  // detection (ignored on resweep of an already-OPEN episode) — computed
  // unconditionally here anyway since it's cheap (two small indexed
  // queries) and simpler than pre-checking whether an OPEN row exists.
  const [{ ltv }, recoveryRate] = await Promise.all([
    abandonedCartsRepository.getCustomerLTV(userId),
    abandonedCartsRepository.getUserRecoveryRate(userId),
  ])
  const minutesSinceAbandonment = (Date.now() - lastActivityMs) / 60000
  const priorityScoring = computeRecoveryPriorityScore({
    cartValue: enrichedCart.subtotal,
    itemCount: enrichedCart.items.length,
    ltv,
    minutesSinceAbandonment,
    recoveryRate,
  })

  const { id, isNew } = await abandonedCartsRepository.recordAbandonment(
    userId,
    enrichedCart,
    lastActivityMs,
    priorityScoring
  )

  if (isNew) {
    logger.info(
      { userId, cartValue: enrichedCart.subtotal, priorityScore: priorityScoring.score },
      'Abandoned cart detected'
    )
    if (_fastify?.emitAbandonedCartUpdate) {
      _fastify.emitAbandonedCartUpdate({ userId, abandonedCartId: id, status: 'DETECTED' })
    }
  }
}

/**
 * Users with a PENDING order awaiting ONLINE/WALLET payment confirmation
 * are excluded from this sweep — that lifecycle already belongs to
 * payment-expiry.worker.js, and treating a mid-payment cart as "abandoned"
 * would be a confusing double-signal for admins.
 */
async function _excludeUsersWithPendingPayment(userIds) {
  if (userIds.length === 0) return new Set()
  const { rows } = await query(
    `SELECT DISTINCT user_id FROM orders
      WHERE user_id = ANY($1::uuid[])
        AND status = 'PENDING'
        AND payment_status = 'PENDING'
        AND payment_method IN ('ONLINE', 'WALLET')`,
    [userIds]
  )
  return new Set(rows.map((r) => r.user_id))
}
