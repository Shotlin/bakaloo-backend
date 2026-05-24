import { logger } from '../../config/logger.js'
import { ORDER_STATUS } from '../../constants/orderStatus.js'

/**
 * Order Splitter — groups a multi-shop cart into one order per shop and
 * persists them atomically inside a single PostgreSQL transaction.
 *
 * Requirements covered:
 *   - 5.6  Group cart items by shop_id and create separate orders
 *   - 5.7  Compute fees independently per shop (free-delivery threshold per shop)
 *   - 5.8  Each order gets its own delivery assignment
 *   - 5.9  Roll back the entire checkout on any failure
 *   - 11.7 SELECT FOR UPDATE on shop_products during stock deduction
 *   - 12.7 Re-validate max_order_qty at checkout
 *   - 15.9/15.10 Multi-table financial writes share a single transaction
 *
 * The splitter is constructed with explicit collaborators so it can be unit
 * tested in isolation:
 *   - ordersRepository       — repo.create(client, …) and repo.generateOrderNumber()
 *   - shopProductsRepository — repo.findByIdForUpdate / repo.applyStockUpdate
 *   - shopProductsService    — optional, exposes
 *       handleStockTransitionSideEffects(...) for post-commit fan-out (Req 11)
 *
 * It does NOT enqueue delivery assignments itself — that responsibility lives
 * with the OrdersService, which reads the returned per-order ids and pushes
 * one job per order onto the existing `orderQueue`. Keeping the splitter pure
 * around the database makes Property 7 (Transaction Atomicity) easy to test.
 *
 * Stock transition side effects (Requirements 11.1–11.4, 11.6, 11.9) are
 * collected during `createOrders` (the in-tx phase records every prev→new
 * transition) and fired by `firePostCommitSideEffects` AFTER the caller's
 * COMMIT. This split keeps the transaction free of best-effort I/O.
 */

const DEFAULT_DELIVERY_FEE = 25
const DEFAULT_PLATFORM_FEE = 5
const DEFAULT_FREE_DELIVERY_THRESHOLD = 499

export class OrderSplitterService {
  /**
   * @param {object} deps
   * @param {object} deps.ordersRepository   - OrdersRepository instance
   * @param {object} deps.shopProductsRepository - ShopProductsRepository instance
   * @param {object} [deps.shopProductsService] - Optional ShopProductsService
   *   used to fire post-commit stock-transition side effects (Req 11). When
   *   omitted, side effects are silently skipped (e.g., test harnesses).
   * @param {object} [deps.fees]
   * @param {number} [deps.fees.deliveryFee=25]
   * @param {number} [deps.fees.platformFee=5]
   * @param {number} [deps.fees.freeDeliveryThreshold=499]
   */
  constructor({
    ordersRepository,
    shopProductsRepository,
    shopProductsService = null,
    fees = {},
  }) {
    if (!ordersRepository) {
      throw new Error('OrderSplitterService requires ordersRepository')
    }
    if (!shopProductsRepository) {
      throw new Error('OrderSplitterService requires shopProductsRepository')
    }
    this.ordersRepo = ordersRepository
    this.shopProductsRepo = shopProductsRepository
    this.shopProductsService = shopProductsService
    this.deliveryFee = Number.isFinite(fees.deliveryFee)
      ? fees.deliveryFee
      : DEFAULT_DELIVERY_FEE
    this.platformFee = Number.isFinite(fees.platformFee)
      ? fees.platformFee
      : DEFAULT_PLATFORM_FEE
    this.freeDeliveryThreshold = Number.isFinite(fees.freeDeliveryThreshold)
      ? fees.freeDeliveryThreshold
      : DEFAULT_FREE_DELIVERY_THRESHOLD
  }

  // ────────────────────────────────────────────────────────
  // Pure split (Requirement 5.6, Property 6)
  // ────────────────────────────────────────────────────────

  /**
   * Group cart items by shop_id.
   *
   * Pure: no IO, deterministic. Used directly by Property 6 tests.
   *
   * @param {Array<{productId: string, shopId: string, quantity: number, [key: string]: any}>} cartItems
   * @returns {Map<string, Array<object>>} Map from shop_id to items
   */
  splitCart(cartItems) {
    const groups = new Map()
    for (const item of cartItems || []) {
      if (!item || !item.shopId) continue
      const arr = groups.get(item.shopId)
      if (arr) arr.push(item)
      else groups.set(item.shopId, [item])
    }
    return groups
  }

  // ────────────────────────────────────────────────────────
  // Fee computation (Requirement 5.7)
  // ────────────────────────────────────────────────────────

  /**
   * Compute per-shop totals. Free-delivery threshold is applied to each
   * shop's subtotal in isolation (Requirement 5.7).
   *
   * @param {Array<object>} items
   * @returns {{
   *   subtotal: number,
   *   deliveryFee: number,
   *   platformFee: number,
   *   totalAmount: number,
   * }}
   */
  computeFees(items) {
    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.lineTotal ?? 0),
      0
    )
    const subtotalRounded = Number(subtotal.toFixed(2))
    const deliveryFee =
      subtotalRounded >= this.freeDeliveryThreshold ? 0 : this.deliveryFee
    const platformFee = this.platformFee
    const totalAmount = Number(
      (subtotalRounded + deliveryFee + platformFee).toFixed(2)
    )
    return {
      subtotal: subtotalRounded,
      deliveryFee,
      platformFee,
      totalAmount,
    }
  }

  // ────────────────────────────────────────────────────────
  // Atomic create (Requirements 5.6, 5.7, 5.8, 5.9, 11.7)
  // ────────────────────────────────────────────────────────

  /**
   * Create per-shop orders inside a transaction owned by the caller.
   * The caller is responsible for `BEGIN`, `COMMIT`, `ROLLBACK` and
   * releasing the client. Throwing from this method causes the caller's
   * outer try/catch to roll back the entire checkout (Property 7).
   *
   * For each shop group:
   *   1. Lock each shop_product row (SELECT FOR UPDATE) — Req 11.7
   *   2. Re-verify max_order_qty + stock — Req 12.7, 5.5
   *   3. Apply stock decrement (sets is_available/sold_out_at as needed)
   *   4. Insert orders + order_items
   *
   * Any per-item failure throws an Error whose `failures` array lists every
   * `{ productId, shopId, reason, code }`. The OrdersService catches that
   * and surfaces a CHECKOUT_PARTIAL_FAIL response.
   *
   * @param {object} args
   * @param {import('pg').PoolClient} args.client - Open transaction client
   * @param {string} args.userId
   * @param {Map<string, Array<object>>} args.groups - Output of splitCart
   * @param {object} args.deliveryAddress
   * @param {object} args.payment - { method, status }
   * @param {object} [args.checkoutMeta] - Coupon, notes, tip, instructions, etc.
   * @returns {Promise<Array<object>>} Per-shop orders created
   */
  async createOrders({
    client,
    userId,
    groups,
    deliveryAddress,
    payment,
    checkoutMeta = {},
  }) {
    if (!client) throw new Error('createOrders requires an open pg client')
    if (!groups || groups.size === 0) {
      const err = new Error('Cart has no items to split')
      err.code = 'EMPTY_CART'
      err.failures = []
      throw err
    }

    const failures = []
    const createdOrders = []
    /**
     * Captured per-row stock transitions for post-commit fan-out
     * (Req 11.1–11.4, 11.6, 11.9). One entry per item; the caller invokes
     * `firePostCommitSideEffects(transitions)` AFTER COMMIT so a flaky
     * Socket.IO server or queue cannot affect transaction semantics.
     */
    const stockTransitions = []

    // Iterate shops in a stable order so test snapshots stay deterministic
    const shopIds = Array.from(groups.keys()).sort()

    for (const shopId of shopIds) {
      const items = groups.get(shopId)

      // ─── 1. Lock + revalidate every shop_product row in this group ────
      const verified = []
      for (const item of items) {
        const locked = await this.shopProductsRepo.findByIdForUpdate(
          client,
          item.shopProductId,
          shopId
        )

        if (!locked) {
          failures.push({
            productId: item.productId,
            shopId,
            reason: 'Product is no longer available in this shop',
            code: 'SHOP_PRODUCT_UNAVAILABLE',
          })
          continue
        }

        if (locked.is_available !== true) {
          failures.push({
            productId: item.productId,
            shopId,
            reason: 'Product is currently unavailable',
            code: 'SHOP_PRODUCT_UNAVAILABLE',
          })
          continue
        }

        // Requirement 12.7 — re-validate max_order_qty at checkout time
        const maxOrderQty = Number(locked.max_order_qty)
        if (item.quantity > maxOrderQty) {
          failures.push({
            productId: item.productId,
            shopId,
            reason: `Quantity exceeds the per-order limit of ${maxOrderQty}`,
            code: 'MAX_QTY_EXCEEDED',
            max: maxOrderQty,
          })
          continue
        }

        const stockQty = Number(locked.stock_quantity)
        if (stockQty < item.quantity) {
          failures.push({
            productId: item.productId,
            shopId,
            reason: `Only ${stockQty} units available`,
            code: 'INSUFFICIENT_STOCK',
            available: stockQty,
          })
          continue
        }

        verified.push({ item, locked })
      }

      if (failures.length > 0) {
        // Bail before any mutation — the caller's catch block will roll back
        // BEGIN. We do NOT continue to other shop groups: Requirement 5.9
        // demands an all-or-nothing checkout.
        const err = new Error('One or more items failed checkout validation')
        err.code = 'CHECKOUT_PARTIAL_FAIL'
        err.failures = failures
        throw err
      }

      // ─── 2. Apply stock decrement (still inside the locked rows) ──────
      for (const { item, locked } of verified) {
        const prevQty = Number(locked.stock_quantity)
        const newQty = prevQty - item.quantity
        const updated = await this.shopProductsRepo.applyStockUpdate(
          client,
          item.shopProductId,
          shopId,
          newQty
        )
        if (!updated) {
          // Should not happen — we just locked the row. Defensive guard.
          const err = new Error('Failed to apply stock update')
          err.code = 'LEDGER_WRITE_FAILED'
          err.failures = [
            {
              productId: item.productId,
              shopId,
              reason: 'Stock update failed',
              code: 'LEDGER_WRITE_FAILED',
            },
          ]
          throw err
        }

        // Record the prev→new transition for post-commit fan-out. The
        // shopProduct object includes everything the side-effect helpers
        // need (id, product_id, stock_quantity, sold_out_at, threshold).
        stockTransitions.push({
          shopId,
          shopProduct: updated,
          prevQty,
          newQty,
          lowStockThreshold: Number(updated.low_stock_threshold),
          productMeta: { product_name: item.name || null },
        })
      }

      // ─── 3. Compute fees per shop and insert order ────────────────────
      const fees = this.computeFees(items)

      const orderItems = items.map((item) => ({
        productId: item.productId,
        shopId,
        name: item.name,
        price: Number(item.salePrice ?? item.price ?? 0),
        quantity: item.quantity,
        unit: item.unit || null,
        total: Number(item.lineTotal ?? 0),
      }))

      const orderNumber = await this.ordersRepo.generateOrderNumber()

      const initialStatus =
        payment?.method === 'COD' ? ORDER_STATUS.CONFIRMED : ORDER_STATUS.PENDING

      const order = await this.ordersRepo.create(
        client,
        {
          orderNumber,
          userId,
          shopId,
          status: initialStatus,
          items: orderItems,
          subtotal: fees.subtotal,
          discountAmount: 0,
          deliveryFee: fees.deliveryFee,
          platformFee: fees.platformFee,
          taxAmount: 0,
          totalAmount: fees.totalAmount,
          paymentMethod: payment?.method || 'COD',
          paymentStatus: payment?.status || 'PENDING',
          couponCode: checkoutMeta.couponCode || null,
          deliveryAddress,
          deliveryNotes: checkoutMeta.deliveryNotes || null,
          estimatedDelivery:
            checkoutMeta.estimatedDelivery ||
            new Date(Date.now() + 30 * 60 * 1000),
          handlingFee: 0,
          lateNightFee: 0,
          tipAmount: 0,
          deliveryInstructions: checkoutMeta.deliveryInstructions || null,
          savingsTotal: 0,
        },
        orderItems
      )

      createdOrders.push(order)
    }

    logger.info(
      {
        userId,
        action: 'order_split',
        shopsCount: shopIds.length,
        orderIds: createdOrders.map((o) => o.id),
      },
      'Per-shop orders created from multi-vendor cart'
    )

    // Attach stock transitions as a non-enumerable property so existing
    // callers that destructure or iterate over the array keep their
    // contract (length, indexed access). Callers that need post-commit
    // side-effect fan-out can read `result.stockTransitions` and pass it
    // through to `firePostCommitSideEffects` AFTER COMMIT.
    Object.defineProperty(createdOrders, 'stockTransitions', {
      value: stockTransitions,
      enumerable: false,
      writable: false,
      configurable: false,
    })

    return createdOrders
  }

  /**
   * Fan out post-commit stock-transition side effects collected during
   * `createOrders` (Requirements 11.1–11.4, 11.6, 11.9). The caller
   * MUST invoke this AFTER the outer transaction has committed so a
   * rolled-back checkout never emits user-facing events or queues jobs.
   *
   * Best-effort: per-transition errors are caught + logged. Individual
   * transition failures cannot affect the customer-facing checkout
   * response or other transitions in the same call.
   *
   * No-op when the splitter wasn't given a `shopProductsService`.
   *
   * @param {Array<{
   *   shopId: string,
   *   shopProduct: object,
   *   prevQty: number,
   *   newQty: number,
   *   lowStockThreshold: number,
   *   productMeta?: { product_name?: string|null }
   * }>} transitions
   */
  async firePostCommitSideEffects(transitions) {
    if (!this.shopProductsService?.handleStockTransitionSideEffects) return
    if (!Array.isArray(transitions) || transitions.length === 0) return

    for (const transition of transitions) {
      try {
        await this.shopProductsService.handleStockTransitionSideEffects(
          transition
        )
      } catch (err) {
        logger.error(
          {
            err: err.message,
            shopId: transition.shopId,
            shopProductId: transition.shopProduct?.id,
            action: 'order_stock_transition_side_effects',
          },
          'Order-driven stock transition side effects failed'
        )
      }
    }
  }
}
