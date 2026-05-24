import { getClient } from '../../config/database.js'
import { cacheGet, cacheSet, cacheDeletePattern } from '../../utils/cache.js'
import { logger } from '../../config/logger.js'
import {
  notificationQueue,
  stockNotificationsQueue,
} from '../../config/bullmq.js'
import { getSocketIo } from '../../plugins/socketio.plugin.js'
import { ShopStaffRepository } from '../shop-staff/shop-staff.repository.js'

/**
 * Shop Products service — business logic with Redis caching and
 * SELECT FOR UPDATE row-level locking on stock writes.
 *
 * Caching (Requirement 14.3):
 *   - Listing pages cached at  bakaloo:shop-products:v1:{shop_id}:p{page}:l{limit}:...
 *   - TTL: 120 seconds
 *   - Any write (create/update/stock/delete) invalidates ALL pages for the shop
 *     via a SCAN-based pattern delete (never KEYS *).
 *
 * Concurrency (Requirements 3.8, 11.7):
 *   - Stock updates run inside a transaction with SELECT … FOR UPDATE so
 *     concurrent deductions can never push stock below zero.
 *   - The DB CHECK constraint (chk_shop_products_stock_quantity) is the final
 *     line of defence, but the service-side guard returns a friendlier code
 *     (INSUFFICIENT_STOCK / NEGATIVE_STOCK).
 *
 * Stock-out side effects (Requirements 11.1, 11.6):
 *   - new=0 → is_available=false, sold_out_at=NOW() (within the same tx)
 *   - new>0 AND was 0 → is_available=true, sold_out_at=NULL (within the same tx)
 *
 * Post-commit side effects (task 13.1, Requirements 11.2, 11.3, 11.4, 11.6, 11.9):
 *   - Stock 5 → 0:
 *       * invalidate Redis listing cache (also covered by every successful write)
 *       * emit Socket.IO `shop:product:stock_out` to channel `shop:{shop_id}`
 *       * push notification to all SHOP_ADMIN/SHOP_MANAGER for this shop
 *   - Stock 0 → 5:
 *       * emit Socket.IO `shop:product:restocked` to channel `shop:{shop_id}`
 *       * enqueue BullMQ `wishlist-restock` job (consumed in task 13.2) so the
 *         worker can fan out push notifications to wishlist customers
 *   - Stock 10 → 3 (threshold=5, still > 0):
 *       * push low-stock notification to all SHOP_ADMIN/SHOP_MANAGER
 *
 * Side effects fire AFTER COMMIT only — a rolled-back transaction never leaks
 * events. Socket.IO is best-effort (catch + log). Notifications go through
 * the existing notification queue; if neither the queue nor a notifications
 * service is available the call is a no-op (best-effort).
 */

const CACHE_PREFIX = 'bakaloo:shop-products:v1'
const CACHE_TTL_SECONDS = 120
const STAFF_ROLES_ALLOWED_TO_MUTATE = new Set([
  'SHOP_ADMIN',
  'SHOP_MANAGER',
  'SHOP_STAFF',
])

export class ShopProductsService {
  /**
   * @param {import('./shop-products.repository.js').ShopProductsRepository} repository
   * @param {object} [deps] - Optional collaborators for post-commit side effects
   * @param {object} [deps.notificationsService] - NotificationsService with
   *   `sendNotification(userId, { title, body, type, data })`. If absent the
   *   service falls back to enqueuing on `notificationQueue` directly so push
   *   delivery still happens via the existing worker pipeline.
   * @param {object} [deps.notificationQueue] - BullMQ queue used as fallback
   *   when no notificationsService is wired (defaults to module-level
   *   `notificationQueue`). Must expose `add(name, data, opts?)`.
   * @param {object} [deps.stockNotificationsQueue] - BullMQ queue used to
   *   enqueue wishlist restock fan-out (defaults to module-level instance).
   * @param {() => import('socket.io').Server | null} [deps.getIo] - Resolver
   *   for the active Socket.IO server. Defaults to the plugin getter so we
   *   don't couple to import order during boot.
   * @param {object} [deps.shopStaffRepository] - Repository used to look up
   *   SHOP_ADMIN/SHOP_MANAGER user_ids when notifying staff (Req 11.4, 11.9).
   */
  constructor(repository, deps = {}) {
    this.repo = repository
    this.notificationsService = deps.notificationsService || null
    this.notificationQueue = deps.notificationQueue || notificationQueue
    this.stockNotificationsQueue =
      deps.stockNotificationsQueue || stockNotificationsQueue
    this._getIo = deps.getIo || getSocketIo
    this.shopStaffRepo =
      deps.shopStaffRepository || new ShopStaffRepository()
  }

  // ────────────────────────────────────────────────────────
  // Post-commit side effects (Requirements 11.2, 11.3, 11.4, 11.6, 11.9)
  //
  // Public API surface (also exercised by OrderSplitter and unit tests):
  //   _emitStockOutEvent
  //   _emitRestockEvent
  //   _notifyStaffStockOut
  //   _notifyStaffLowStock
  //   _enqueueWishlistRestockNotifications
  //   handleStockTransitionSideEffects(shopId, prevQty, newQty, threshold, ...)
  //
  // The first five are best-effort: every failure is caught + logged so a
  // flaky Redis or Socket.IO server cannot affect the customer-facing API
  // response. The orchestrator (`handleStockTransitionSideEffects`) detects
  // the transition and fans out to whichever helpers apply.
  // ────────────────────────────────────────────────────────

  /**
   * Emit Socket.IO `shop:product:stock_out` to channel `shop:{shop_id}`
   * (Requirement 11.3). Best-effort — failures are caught and logged.
   *
   * @param {string} shopId
   * @param {{ id: string, product_id: string, product_name?: string|null,
   *           sold_out_at?: Date|string|null }} shopProduct
   */
  _emitStockOutEvent(shopId, shopProduct) {
    try {
      const io = this._getIo && this._getIo()
      if (!io || !shopId) return
      io.to(`shop:${shopId}`).emit('shop:product:stock_out', {
        shop_product_id: shopProduct.id,
        product_id: shopProduct.product_id,
        product_name: shopProduct.product_name || null,
        shop_id: shopId,
        stock_quantity: 0,
        sold_out_at: shopProduct.sold_out_at || new Date().toISOString(),
      })
    } catch (err) {
      logger.error(
        { err: err.message, shopId, action: 'emit_stock_out' },
        'Socket.IO stock-out emission failed'
      )
    }
  }

  /**
   * Emit Socket.IO `shop:product:restocked` to channel `shop:{shop_id}`
   * (mirror of stock-out, Requirement 11.6). Best-effort.
   *
   * @param {string} shopId
   * @param {{ id: string, product_id: string, product_name?: string|null,
   *           stock_quantity: number }} shopProduct
   */
  _emitRestockEvent(shopId, shopProduct) {
    try {
      const io = this._getIo && this._getIo()
      if (!io || !shopId) return
      io.to(`shop:${shopId}`).emit('shop:product:restocked', {
        shop_product_id: shopProduct.id,
        product_id: shopProduct.product_id,
        product_name: shopProduct.product_name || null,
        shop_id: shopId,
        stock_quantity: Number(shopProduct.stock_quantity),
      })
    } catch (err) {
      logger.error(
        { err: err.message, shopId, action: 'emit_restocked' },
        'Socket.IO restock emission failed'
      )
    }
  }

  /**
   * Push a notification to every active SHOP_ADMIN / SHOP_MANAGER on a
   * shop. Centralises the fan-out so stock-out and low-stock notifiers
   * share the same delivery path (Req 11.4, 11.9).
   *
   * Delivery preference: `notificationsService.sendNotification` (which
   * also creates an in-app row + Socket.IO emit). Falls back to enqueuing
   * a `push` job on `notificationQueue` so the existing worker pipeline
   * still delivers FCM payloads when the service isn't wired.
   *
   * Best-effort: any error is caught and logged.
   *
   * @param {string} shopId
   * @param {{ title: string, body: string, type: string, data: object }} payload
   * @returns {Promise<{ delivered: number }>}
   * @private
   */
  async _notifyShopStaff(shopId, payload) {
    let userIds = []
    try {
      userIds = await this.shopStaffRepo.findActiveUserIdsByShopAndRoles(
        shopId,
        ['SHOP_ADMIN', 'SHOP_MANAGER']
      )
    } catch (err) {
      logger.error(
        { err: err.message, shopId, action: payload.type },
        'Staff lookup failed; skipping notification fan-out'
      )
      return { delivered: 0 }
    }

    if (userIds.length === 0) return { delivered: 0 }

    let delivered = 0
    for (const userId of userIds) {
      try {
        if (this.notificationsService?.sendNotification) {
          await this.notificationsService.sendNotification(userId, payload)
        } else if (this.notificationQueue?.add) {
          await this.notificationQueue.add(
            'push',
            {
              type: 'push',
              userId,
              title: payload.title,
              body: payload.body,
              data: payload.data || {},
            },
            { removeOnComplete: true }
          )
        } else {
          // No delivery path wired — log once per fan-out for visibility.
          logger.debug(
            { userId, shopId, action: payload.type },
            'Notifications service and queue both unavailable; skipping'
          )
          continue
        }
        delivered += 1
      } catch (err) {
        logger.error(
          { err: err.message, userId, shopId, action: payload.type },
          'Staff notification delivery failed'
        )
      }
    }
    return { delivered }
  }

  /**
   * Notify SHOP_ADMIN / SHOP_MANAGER that a product is out of stock
   * (Requirement 11.4).
   *
   * @param {string} shopId
   * @param {{ id: string, product_id: string, product_name?: string|null }} shopProduct
   */
  async _notifyStaffStockOut(shopId, shopProduct) {
    const productLabel = shopProduct.product_name || 'A product'
    return this._notifyShopStaff(shopId, {
      title: 'Product out of stock',
      body: `${productLabel} just went out of stock and is hidden from customers.`,
      type: 'stock_out',
      data: {
        shop_id: shopId,
        shop_product_id: shopProduct.id,
        product_id: shopProduct.product_id,
        stock_quantity: 0,
      },
    })
  }

  /**
   * Notify SHOP_ADMIN / SHOP_MANAGER that a product crossed the low-stock
   * threshold (Requirement 11.9). Caller is responsible for confirming
   * the threshold transition; this helper just builds and dispatches the
   * payload.
   *
   * @param {string} shopId
   * @param {{ id: string, product_id: string, product_name?: string|null,
   *           stock_quantity: number, low_stock_threshold: number }} shopProduct
   */
  async _notifyStaffLowStock(shopId, shopProduct) {
    const productLabel = shopProduct.product_name || 'A product'
    const qty = Number(shopProduct.stock_quantity)
    const threshold = Number(shopProduct.low_stock_threshold)
    return this._notifyShopStaff(shopId, {
      title: 'Low stock alert',
      body: `${productLabel} is running low (${qty} left, threshold ${threshold}).`,
      type: 'low_stock',
      data: {
        shop_id: shopId,
        shop_product_id: shopProduct.id,
        product_id: shopProduct.product_id,
        stock_quantity: qty,
        low_stock_threshold: threshold,
      },
    })
  }

  /**
   * Enqueue a BullMQ `wishlist-restock` job so the stock-notifications
   * worker (task 13.2) can fan out push notifications to customers who
   * wishlisted the product (Requirements 11.6, 3.4).
   *
   * Best-effort: failures are caught + logged so a flaky Redis cannot
   * fail the calling stock update or order placement.
   *
   * @param {string} shopProductId
   * @param {string} productId
   * @param {string} shopId
   */
  async _enqueueWishlistRestockNotifications(shopProductId, productId, shopId) {
    try {
      if (!this.stockNotificationsQueue?.add) return
      await this.stockNotificationsQueue.add(
        'wishlist-restock',
        {
          type: 'wishlist-restock',
          shop_product_id: shopProductId,
          product_id: productId,
          shop_id: shopId,
        },
        {
          // No strict jobId here: rapid 0→N→0→M transitions are independent
          // restock events worth notifying on. Bull's default attempts/
          // backoff configured at queue level handles retry semantics.
          removeOnComplete: true,
        }
      )
    } catch (err) {
      logger.error(
        {
          err: err.message,
          shopId,
          shopProductId,
          productId,
          action: 'enqueue_wishlist_restock',
        },
        'Failed to enqueue wishlist restock notifications'
      )
    }
  }

  /**
   * Detect a stock transition and fan out the matching side effects
   * (Requirements 11.2, 11.3, 11.4, 11.6, 11.9). This is the single
   * post-commit entry point used by both `updateStock` (manual stock
   * adjustments) and the OrderSplitter (order-driven decrements).
   *
   * Transitions handled:
   *   - prev > 0  && new === 0  → emit stock_out + notify staff
   *   - prev === 0 && new > 0   → emit restocked + enqueue wishlist fan-out
   *   - prev > new && new > 0
   *     && new <= threshold      → notify staff low stock
   *
   * The caller passes the FRESH row (post-update) plus the previous
   * quantity. A `productMeta` object with `{ product_name }` lets callers
   * avoid an extra lookup; if absent the helper falls back to
   * `findProductMetaById` so payloads still carry a human-readable name.
   *
   * @param {object} args
   * @param {string} args.shopId
   * @param {object} args.shopProduct - Updated shop_product row
   * @param {number} args.prevQty
   * @param {number} args.newQty
   * @param {number} args.lowStockThreshold
   * @param {{ product_name?: string|null }} [args.productMeta]
   */
  async handleStockTransitionSideEffects({
    shopId,
    shopProduct,
    prevQty,
    newQty,
    lowStockThreshold,
    productMeta,
  }) {
    if (!shopProduct || !shopId) return

    // Resolve product name (best-effort, single PK lookup).
    let resolvedName = productMeta?.product_name ?? shopProduct.product_name
    if (resolvedName === undefined || resolvedName === null) {
      try {
        const meta = await this.repo.findProductMetaById(shopProduct.id, shopId)
        resolvedName = meta?.product_name || null
      } catch {
        resolvedName = null
      }
    }
    const enriched = { ...shopProduct, product_name: resolvedName }

    const prev = Number(prevQty)
    const next = Number(newQty)
    const threshold = Number(lowStockThreshold)

    // Stock-out: prev > 0 → new === 0
    if (prev > 0 && next === 0) {
      this._emitStockOutEvent(shopId, enriched)
      await this._notifyStaffStockOut(shopId, enriched)
      return
    }

    // Restock: prev === 0 → new > 0
    if (prev === 0 && next > 0) {
      this._emitRestockEvent(shopId, enriched)
      await this._enqueueWishlistRestockNotifications(
        enriched.id,
        enriched.product_id,
        shopId
      )
      return
    }

    // Low stock: a deduction kept us above zero but at or below threshold.
    if (
      prev > next &&
      next > 0 &&
      Number.isFinite(threshold) &&
      threshold > 0 &&
      next <= threshold
    ) {
      await this._notifyStaffLowStock(shopId, {
        ...enriched,
        low_stock_threshold: threshold,
      })
    }
  }

  // ────────────────────────────────────────────────────────
  // Authorization helpers
  // ────────────────────────────────────────────────────────

  /**
   * Verify the caller can mutate inventory for the active shop.
   * Allowed: platform ADMIN OR shop staff with SHOP_ADMIN/MANAGER/STAFF role
   * for the same shop_id (Requirement 3.10).
   *
   * The shop-scope middleware already guarantees `request.shopId` matches the
   * staff JWT; this is a defence-in-depth check on role.
   *
   * @param {object} actor - { role, shopRole }
   * @returns {{ ok: boolean, message?: string, code?: string }}
   */
  authorizeMutation(actor) {
    if (!actor) return { ok: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    if (actor.role === 'ADMIN') return { ok: true }
    if (STAFF_ROLES_ALLOWED_TO_MUTATE.has(actor.shopRole)) return { ok: true }
    return {
      ok: false,
      message: 'Only Shop Admin, Manager, or Staff can manage shop products',
      code: 'FORBIDDEN',
    }
  }

  // ────────────────────────────────────────────────────────
  // Cache helpers
  // ────────────────────────────────────────────────────────

  cacheKeyForList(shopId, filters) {
    const { page, limit, is_available, low_stock, search, includeDeleted } =
      filters
    const parts = [`${CACHE_PREFIX}:${shopId}`, `p${page}`, `l${limit}`]
    if (is_available) parts.push(`a${is_available}`)
    if (low_stock) parts.push(`ls${low_stock}`)
    if (search) parts.push(`s${search}`)
    if (includeDeleted) parts.push('inc-del')
    return parts.join(':')
  }

  /**
   * Invalidate all cached listing pages for a shop.
   * Pattern-based SCAN, not KEYS *.
   * @param {string} shopId
   */
  async invalidateShopCache(shopId) {
    await cacheDeletePattern(`${CACHE_PREFIX}:${shopId}:*`)
  }

  // ────────────────────────────────────────────────────────
  // CRUD
  // ────────────────────────────────────────────────────────

  /**
   * Create a shop_product.
   * @param {string} shopId - Resolved by shop-scope middleware
   * @param {object} data - Validated body
   * @param {object} actor - { id, role, shopRole }
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async create(shopId, data, actor) {
    const auth = this.authorizeMutation(actor)
    if (!auth.ok) return { success: false, message: auth.message, code: auth.code }

    // Requirement 3.2 — UNIQUE(shop_id, product_id)
    const existing = await this.repo.findByShopAndProduct(
      shopId,
      data.product_id
    )
    if (existing && !existing.deleted_at) {
      return {
        success: false,
        message: 'This product is already listed for the shop',
        code: 'SHOP_PRODUCT_DUPLICATE',
      }
    }

    // Requirement 3.9 — sale_price < price (also enforced in Zod superRefine,
    // re-checked here so callers using the service directly stay consistent)
    if (
      data.price != null &&
      data.sale_price != null &&
      data.sale_price >= data.price
    ) {
      return {
        success: false,
        message: 'sale_price must be less than price',
        code: 'SALE_PRICE_INVALID',
      }
    }

    // Initial availability follows stock state (Requirement 11.1)
    const desiredAvailability =
      data.stock_quantity === 0 ? false : data.is_available

    const created = await this.repo.create({
      ...data,
      shop_id: shopId,
      is_available: desiredAvailability,
    })

    await this.invalidateShopCache(shopId)

    logger.info(
      {
        userId: actor.id,
        shopId,
        action: 'shop_product_created',
        shopProductId: created.id,
      },
      'Shop product created'
    )

    return { success: true, data: created }
  }

  /**
   * Get a single shop_product (scoped to shop_id).
   * @param {string} shopId
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(shopId, id) {
    return this.repo.findById(id, shopId)
  }

  /**
   * List shop_products for a shop with pagination and Redis caching.
   * @param {string} shopId
   * @param {object} filters
   * @returns {Promise<{items, total, page, limit}>}
   */
  async list(shopId, filters) {
    const includeDeleted = filters.include_deleted === 'true'
    const cacheKey = this.cacheKeyForList(shopId, {
      ...filters,
      includeDeleted,
    })

    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const { items, total } = await this.repo.findMany({
      shopId,
      page: filters.page,
      limit: filters.limit,
      is_available: filters.is_available,
      low_stock: filters.low_stock,
      search: filters.search,
      includeDeleted,
    })

    const result = {
      items,
      total,
      page: filters.page,
      limit: filters.limit,
    }

    await cacheSet(cacheKey, result, CACHE_TTL_SECONDS)
    return result
  }

  /**
   * Update non-stock fields on a shop_product.
   * Stock changes go through `updateStock` (which holds a row lock).
   *
   * @param {string} shopId
   * @param {string} id
   * @param {object} data
   * @param {object} actor - { id, role, shopRole }
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async update(shopId, id, data, actor) {
    const auth = this.authorizeMutation(actor)
    if (!auth.ok) return { success: false, message: auth.message, code: auth.code }

    const existing = await this.repo.findById(id, shopId)
    if (!existing) {
      return {
        success: false,
        message: 'Shop product not found',
        code: 'SHOP_PRODUCT_NOT_FOUND',
      }
    }

    // Requirement 3.9 — sale_price < price using the merged values
    const merged = {
      price: data.price !== undefined ? data.price : existing.price,
      sale_price:
        data.sale_price !== undefined ? data.sale_price : existing.sale_price,
    }
    if (
      merged.price != null &&
      merged.sale_price != null &&
      Number(merged.sale_price) >= Number(merged.price)
    ) {
      return {
        success: false,
        message: 'sale_price must be less than price',
        code: 'SALE_PRICE_INVALID',
      }
    }

    const updated = await this.repo.update(id, shopId, data)
    if (!updated) {
      return {
        success: false,
        message: 'Shop product not found',
        code: 'SHOP_PRODUCT_NOT_FOUND',
      }
    }

    await this.invalidateShopCache(shopId)

    logger.info(
      {
        userId: actor.id,
        shopId,
        action: 'shop_product_updated',
        shopProductId: id,
      },
      'Shop product updated'
    )

    return { success: true, data: updated }
  }

  /**
   * Soft-delete a shop_product.
   * @param {string} shopId
   * @param {string} id
   * @param {object} actor - { id, role, shopRole }
   */
  async delete(shopId, id, actor) {
    const auth = this.authorizeMutation(actor)
    if (!auth.ok) return { success: false, message: auth.message, code: auth.code }

    const existing = await this.repo.findById(id, shopId)
    if (!existing) {
      return {
        success: false,
        message: 'Shop product not found',
        code: 'SHOP_PRODUCT_NOT_FOUND',
      }
    }

    const deleted = await this.repo.softDelete(id, shopId)
    if (!deleted) {
      return {
        success: false,
        message: 'Shop product not found',
        code: 'SHOP_PRODUCT_NOT_FOUND',
      }
    }

    await this.invalidateShopCache(shopId)

    logger.info(
      {
        userId: actor.id,
        shopId,
        action: 'shop_product_deleted',
        shopProductId: id,
      },
      'Shop product soft-deleted'
    )

    return { success: true }
  }

  // ────────────────────────────────────────────────────────
  // Stock update — SELECT FOR UPDATE inside a transaction
  // ────────────────────────────────────────────────────────

  /**
   * Update stock_quantity using a row-level lock so concurrent writers cannot
   * drive stock below zero (Requirements 3.5, 3.8, 11.7).
   *
   * Modes:
   *   - { stock_quantity: N } — set absolute value
   *   - { delta: D }          — apply delta (+/-) to the locked value
   *
   * Returns:
   *   - success: { data: updated row, prev: {...} }
   *   - failure: SHOP_PRODUCT_NOT_FOUND | INSUFFICIENT_STOCK | NEGATIVE_STOCK
   *
   * Stock-out side effects (is_available, sold_out_at) are applied within the
   * same transaction; Socket.IO + push notifications are deferred to task 13.1.
   *
   * @param {string} shopId
   * @param {string} id
   * @param {{ stock_quantity?: number, delta?: number, reason?: string }} body
   * @param {object} actor - { id, role, shopRole }
   * @returns {Promise<{success, data?, prev?, message?, code?}>}
   */
  async updateStock(shopId, id, body, actor) {
    const auth = this.authorizeMutation(actor)
    if (!auth.ok) return { success: false, message: auth.message, code: auth.code }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const locked = await this.repo.findByIdForUpdate(client, id, shopId)
      if (!locked) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: 'Shop product not found',
          code: 'SHOP_PRODUCT_NOT_FOUND',
        }
      }

      const prevQty = Number(locked.stock_quantity)
      const newQty =
        body.stock_quantity !== undefined
          ? Number(body.stock_quantity)
          : prevQty + Number(body.delta)

      // Service-side guards (DB CHECK is the final defence)
      if (!Number.isFinite(newQty) || !Number.isInteger(newQty)) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: 'Resulting stock_quantity must be a finite integer',
          code: 'INVALID_STOCK_VALUE',
        }
      }

      if (newQty < 0) {
        await client.query('ROLLBACK')
        // Differentiate: delta would push below 0 vs absolute negative input
        const code =
          body.delta !== undefined ? 'INSUFFICIENT_STOCK' : 'NEGATIVE_STOCK'
        return {
          success: false,
          message: 'Stock quantity cannot be negative. Available: ' + prevQty,
          code,
        }
      }

      const updated = await this.repo.applyStockUpdate(
        client,
        id,
        shopId,
        newQty
      )
      if (!updated) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: 'Shop product not found',
          code: 'SHOP_PRODUCT_NOT_FOUND',
        }
      }

      await client.query('COMMIT')

      // Cache invalidation runs after commit so readers don't repopulate stale
      // entries from the in-flight transaction snapshot.
      await this.invalidateShopCache(shopId)

      logger.info(
        {
          userId: actor.id,
          shopId,
          action: 'shop_product_stock_updated',
          shopProductId: id,
          prevQty,
          newQty,
          reason: body.reason || null,
        },
        'Shop product stock updated'
      )

      // Post-commit side effects (Req 11.2-11.4, 11.6, 11.9). All best-effort:
      // a Socket.IO or queue failure must not flip the API response that the
      // operator just saw succeed.
      try {
        await this.handleStockTransitionSideEffects({
          shopId,
          shopProduct: updated,
          prevQty,
          newQty,
          lowStockThreshold: Number(updated.low_stock_threshold),
        })
      } catch (sideErr) {
        logger.error(
          {
            err: sideErr.message,
            shopId,
            shopProductId: id,
            action: 'stock_transition_side_effects',
          },
          'Stock transition side effects failed (transaction already committed)'
        )
      }

      return {
        success: true,
        data: updated,
        prev: {
          stock_quantity: prevQty,
          is_available: locked.is_available,
        },
      }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      // Surface the DB CHECK error as a friendly code if it slips through
      // (e.g., raced with another worker that decremented the row).
      if (err && err.code === '23514') {
        return {
          success: false,
          message: 'Stock quantity violates DB constraint (>= 0)',
          code: 'NEGATIVE_STOCK',
        }
      }
      throw err
    } finally {
      client.release()
    }
  }
}
