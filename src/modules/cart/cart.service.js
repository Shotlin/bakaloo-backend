import { logger } from '../../config/logger.js'

/**
 * Multi-vendor cart service.
 *
 * Cart line item shape (Redis):
 *   { productId, shopId, quantity }
 *
 * Validation rules at addItem and validateCart:
 *   - Shop must be in user's User_Shop_Allocations          (Req 5.2)
 *   - Shop must be active and not soft-deleted              (Req 5.3)
 *   - quantity ≤ shop_products.stock_quantity               (Req 5.5)
 *   - per-line-item + per-product-in-cart quantity ≤
 *     shop_products.max_order_qty                            (Req 5.4, 12.2)
 *   - cart never exceeds MAX_CART_ITEMS distinct line items (Req 5.1)
 *
 * Errors are returned as `{ success:false, message, code }` envelopes so
 * callers (controller / OrderSplitter) can render them consistently.
 */
export const MAX_CART_ITEMS = 50

export class CartService {
  constructor(repository) {
    this.repo = repository
  }

  // ────────────────────────────────────────────────────────
  // Public read paths
  // ────────────────────────────────────────────────────────

  /**
   * Get an enriched view of the cart for the API.
   */
  async getCart(userId) {
    const cartItems = await this.repo.getCart(userId)
    if (cartItems.length === 0) {
      return this._emptyEnriched(userId)
    }
    return this._enrichCart(userId, cartItems)
  }

  // ────────────────────────────────────────────────────────
  // Add / update / remove
  // ────────────────────────────────────────────────────────

  /**
   * Add a product (from a specific shop) to the cart.
   *
   * If `shopId` is omitted the service auto-resolves the shop when there is
   * exactly one available shop for the product across the user's allocations
   * (preserves backwards-compatible callers that don't yet pass shop_id).
   */
  async addItem(userId, { productId, shopId = null, quantity }) {
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty <= 0) {
      return {
        success: false,
        message: 'Quantity must be a positive integer',
        code: 'INVALID_QUANTITY',
      }
    }

    let resolvedShopId = shopId
    if (!resolvedShopId) {
      const candidates = await this.repo.findShopProductsForProduct(
        userId,
        productId
      )
      if (candidates.length === 0) {
        return {
          success: false,
          message: 'Product is not available in any of your shops',
          code: 'SHOP_NOT_AVAILABLE',
        }
      }
      if (candidates.length > 1) {
        return {
          success: false,
          message:
            'Multiple shops carry this product. Please specify which shop to order from.',
          code: 'CART_SHOP_REQUIRED',
        }
      }
      resolvedShopId = candidates[0].shop_id
    }

    const sp = await this.repo.findShopProductForUser(
      userId,
      productId,
      resolvedShopId
    )
    if (!sp) {
      return {
        success: false,
        message: 'This shop is not available to you',
        code: 'SHOP_NOT_AVAILABLE',
      }
    }

    const shopActive = sp.shop_active === true
    if (!shopActive) {
      return {
        success: false,
        message: 'This shop is currently inactive',
        code: 'SHOP_INACTIVE',
      }
    }

    const productActive = sp.product_active === true
    if (!productActive || sp.is_available !== true) {
      return {
        success: false,
        message: 'This product is currently unavailable',
        code: 'SHOP_PRODUCT_UNAVAILABLE',
      }
    }

    const cartItems = await this.repo.getCart(userId)
    const existingIndex = cartItems.findIndex(
      (i) => i.productId === productId && i.shopId === resolvedShopId
    )
    const existingQty = existingIndex >= 0 ? cartItems[existingIndex].quantity : 0
    const newQty = existingQty + qty

    const maxOrderQty = Number(sp.max_order_qty)
    if (newQty > maxOrderQty) {
      return {
        success: false,
        message: `Maximum ${maxOrderQty} units of "${sp.name}" allowed per order`,
        code: 'MAX_QTY_EXCEEDED',
        details: { productId, shopId: resolvedShopId, max: maxOrderQty },
      }
    }

    const stockQuantity = Number(sp.stock_quantity)
    if (newQty > stockQuantity) {
      return {
        success: false,
        message: `Only ${stockQuantity} units of "${sp.name}" available`,
        code: 'INSUFFICIENT_STOCK',
        details: {
          productId,
          shopId: resolvedShopId,
          available: stockQuantity,
        },
      }
    }

    if (existingIndex >= 0) {
      cartItems[existingIndex].quantity = newQty
    } else {
      if (cartItems.length >= MAX_CART_ITEMS) {
        return {
          success: false,
          message: `Cart is limited to ${MAX_CART_ITEMS} distinct items`,
          code: 'CART_LIMIT_EXCEEDED',
          details: { max: MAX_CART_ITEMS },
        }
      }
      cartItems.push({ productId, shopId: resolvedShopId, quantity: newQty })
    }

    await this.repo.saveCart(userId, cartItems)
    logger.info(
      {
        userId,
        productId,
        shopId: resolvedShopId,
        quantity: newQty,
        action: 'cart_item_added',
      },
      'Cart item added/updated'
    )

    return { success: true, cart: await this._enrichCart(userId, cartItems) }
  }

  /**
   * Update item quantity (absolute, not delta).
   * Identifies the line by (productId, shopId).
   */
  async updateItem(userId, productId, quantity, shopId = null) {
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty <= 0) {
      return {
        success: false,
        message: 'Quantity must be a positive integer',
        code: 'INVALID_QUANTITY',
      }
    }

    const cartItems = await this.repo.getCart(userId)
    const matches = cartItems
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => {
        if (item.productId !== productId) return false
        if (shopId && item.shopId !== shopId) return false
        return true
      })

    if (matches.length === 0) {
      return { success: false, message: 'Item not in cart', code: 'CART_ITEM_NOT_FOUND' }
    }
    if (matches.length > 1) {
      return {
        success: false,
        message: 'Multiple cart entries match. Please specify shop_id.',
        code: 'CART_SHOP_REQUIRED',
      }
    }

    const { item, idx } = matches[0]

    const sp = await this.repo.findShopProductForUser(
      userId,
      item.productId,
      item.shopId
    )
    if (!sp) {
      cartItems.splice(idx, 1)
      await this.repo.saveCart(userId, cartItems)
      return {
        success: false,
        message: 'This shop is no longer available',
        code: 'SHOP_NOT_AVAILABLE',
      }
    }

    if (sp.shop_active !== true) {
      cartItems.splice(idx, 1)
      await this.repo.saveCart(userId, cartItems)
      return {
        success: false,
        message: 'This shop is currently inactive',
        code: 'SHOP_INACTIVE',
      }
    }

    if (sp.product_active !== true || sp.is_available !== true) {
      cartItems.splice(idx, 1)
      await this.repo.saveCart(userId, cartItems)
      return {
        success: false,
        message: 'This product is currently unavailable',
        code: 'SHOP_PRODUCT_UNAVAILABLE',
      }
    }

    const maxOrderQty = Number(sp.max_order_qty)
    if (qty > maxOrderQty) {
      return {
        success: false,
        message: `Maximum ${maxOrderQty} units of "${sp.name}" allowed per order`,
        code: 'MAX_QTY_EXCEEDED',
        details: { productId, shopId: item.shopId, max: maxOrderQty },
      }
    }

    const stockQuantity = Number(sp.stock_quantity)
    if (qty > stockQuantity) {
      return {
        success: false,
        message: `Only ${stockQuantity} units of "${sp.name}" available`,
        code: 'INSUFFICIENT_STOCK',
        details: { productId, shopId: item.shopId, available: stockQuantity },
      }
    }

    cartItems[idx].quantity = qty
    await this.repo.saveCart(userId, cartItems)

    return { success: true, cart: await this._enrichCart(userId, cartItems) }
  }

  /**
   * Remove an item from the cart, identified by (productId, shopId).
   */
  async removeItem(userId, productId, shopId = null) {
    const cartItems = await this.repo.getCart(userId)
    const filtered = cartItems.filter((i) => {
      if (i.productId !== productId) return true
      if (shopId && i.shopId !== shopId) return true
      return false
    })

    if (filtered.length === cartItems.length) {
      return { success: false, message: 'Item not in cart', code: 'CART_ITEM_NOT_FOUND' }
    }

    await this.repo.saveCart(userId, filtered)
    return { success: true, cart: await this._enrichCart(userId, filtered) }
  }

  /**
   * Clear the entire cart, including extras (tip + delivery instructions).
   * Used by the checkout success path so post-order users do not see stale
   * carts (Requirement 5.6 — atomicity around checkout).
   */
  async clearCart(userId) {
    await this.repo.clearCart(userId)
    await this.repo.clearExtras(userId)
  }

  // ────────────────────────────────────────────────────────
  // Validation — used at checkout (Req 12.3)
  // ────────────────────────────────────────────────────────

  /**
   * Validate the cart against current allocations, shop activity, max_order_qty
   * and stock_quantity. Returns the validated items along with a list of
   * `failed` entries `{ productId, shopId, reason, code }` that the order
   * service surfaces back to the customer (Requirement 5.9).
   *
   * The cart in Redis is rewritten with only the validated items so a
   * subsequent retry by the customer reflects the current reality.
   */
  async validateCart(userId) {
    const cartItems = await this.repo.getCart(userId)
    if (cartItems.length === 0) {
      return {
        valid: false,
        items: [],
        subtotal: 0,
        failed: [],
        warnings: ['Cart is empty'],
        groupedByShop: new Map(),
      }
    }

    const rows = await this.repo.findShopProductsForCart(userId, cartItems)
    const byKey = new Map(
      rows.map((r) => [`${r.product_id}:${r.shop_id}`, r])
    )

    const failed = []
    const validItems = []
    let subtotal = 0

    for (const item of cartItems) {
      const sp = byKey.get(`${item.productId}:${item.shopId}`)
      if (!sp) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: 'Shop is not available',
          code: 'SHOP_NOT_AVAILABLE',
        })
        continue
      }

      if (sp.shop_active !== true) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: 'Shop is currently inactive',
          code: 'SHOP_INACTIVE',
        })
        continue
      }

      if (sp.product_active !== true || sp.is_available !== true) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: 'Product is currently unavailable',
          code: 'SHOP_PRODUCT_UNAVAILABLE',
        })
        continue
      }

      const maxOrderQty = Number(sp.max_order_qty)
      if (item.quantity > maxOrderQty) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: `Quantity exceeds the per-order limit of ${maxOrderQty}`,
          code: 'MAX_QTY_EXCEEDED',
          max: maxOrderQty,
        })
        continue
      }

      const stockQuantity = Number(sp.stock_quantity)
      if (item.quantity > stockQuantity) {
        failed.push({
          productId: item.productId,
          shopId: item.shopId,
          reason: `Only ${stockQuantity} units available`,
          code: 'INSUFFICIENT_STOCK',
          available: stockQuantity,
        })
        continue
      }

      const effective = this._effectivePrice(sp)
      const lineTotal = parseFloat((effective * item.quantity).toFixed(2))
      subtotal += lineTotal

      validItems.push(this._formatLine(sp, item, effective, lineTotal))
    }

    // Persist validated items back to Redis (drops failed entries so the
    // user's next view shows the current cart state).
    await this.repo.saveCart(
      userId,
      validItems.map((i) => ({
        productId: i.productId,
        shopId: i.shopId,
        quantity: i.quantity,
      }))
    )

    const groupedByShop = new Map()
    for (const item of validItems) {
      const list = groupedByShop.get(item.shopId)
      if (list) list.push(item)
      else groupedByShop.set(item.shopId, [item])
    }

    return {
      valid: failed.length === 0 && validItems.length > 0,
      items: validItems,
      subtotal: parseFloat(subtotal.toFixed(2)),
      failed,
      warnings: failed.map((f) => f.reason),
      groupedByShop,
    }
  }

  // ────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────

  async _emptyEnriched(userId) {
    const [tipAmount, deliveryInstructions] = await Promise.all([
      this.repo.getTip(userId),
      this.repo.getInstructions(userId),
    ])
    return {
      items: [],
      subtotal: 0,
      count: 0,
      totalMrp: 0,
      totalSavings: 0,
      tipAmount,
      deliveryInstructions,
      shopGroups: [],
    }
  }

  /** Enrich raw cart items with current product data for display. */
  async _enrichCart(userId, cartItems) {
    if (cartItems.length === 0) return this._emptyEnriched(userId)

    const [rows, tipAmount, deliveryInstructions] = await Promise.all([
      this.repo.findShopProductsForCart(userId, cartItems),
      this.repo.getTip(userId),
      this.repo.getInstructions(userId),
    ])
    const byKey = new Map(
      rows.map((r) => [`${r.product_id}:${r.shop_id}`, r])
    )

    let subtotal = 0
    let totalMrp = 0
    const items = []

    for (const item of cartItems) {
      const sp = byKey.get(`${item.productId}:${item.shopId}`)
      if (!sp) continue
      if (sp.shop_active !== true) continue
      if (sp.product_active !== true) continue

      const effective = this._effectivePrice(sp)
      const listPrice = this._listPrice(sp)
      const lineTotal = parseFloat((effective * item.quantity).toFixed(2))
      subtotal += lineTotal
      totalMrp += listPrice * item.quantity

      items.push(this._formatLine(sp, item, effective, lineTotal))
    }

    const shopGroups = []
    const grouped = new Map()
    for (const item of items) {
      const arr = grouped.get(item.shopId)
      if (arr) arr.push(item)
      else grouped.set(item.shopId, [item])
    }
    for (const [shopId, shopItems] of grouped) {
      const shopSubtotal = shopItems.reduce(
        (sum, i) => sum + i.lineTotal,
        0
      )
      shopGroups.push({
        shopId,
        shopName: shopItems[0].shopName,
        items: shopItems,
        subtotal: parseFloat(shopSubtotal.toFixed(2)),
        itemCount: shopItems.reduce((n, i) => n + i.quantity, 0),
      })
    }

    const normalizedSubtotal = parseFloat(subtotal.toFixed(2))
    const normalizedMrp = parseFloat(totalMrp.toFixed(2))

    return {
      items,
      subtotal: normalizedSubtotal,
      count: items.reduce((sum, i) => sum + i.quantity, 0),
      totalMrp: normalizedMrp,
      totalSavings: parseFloat((normalizedMrp - normalizedSubtotal).toFixed(2)),
      tipAmount,
      deliveryInstructions,
      shopGroups,
    }
  }

  _effectivePrice(sp) {
    // shop-level override first, falling back to master catalog
    const sale = sp.sp_sale_price ?? sp.product_sale_price
    const list = sp.sp_price ?? sp.product_price
    const price = sale ?? list
    const num = Number(price)
    return Number.isFinite(num) ? num : 0
  }

  _listPrice(sp) {
    const list = sp.sp_price ?? sp.product_price
    const num = Number(list)
    return Number.isFinite(num) ? num : 0
  }

  _formatLine(sp, item, effective, lineTotal) {
    const listPrice = this._listPrice(sp)
    const sale = sp.sp_sale_price ?? sp.product_sale_price
    const salePrice = sale !== null && sale !== undefined ? Number(sale) : null
    return {
      productId: sp.product_id,
      shopId: sp.shop_id,
      shopProductId: sp.shop_product_id,
      shopName: sp.shop_name || null,
      name: sp.name,
      slug: sp.slug,
      price: listPrice,
      originalPrice:
        salePrice !== null && salePrice < listPrice ? listPrice : null,
      salePrice,
      quantity: item.quantity,
      unit: sp.unit,
      image: sp.thumbnail_url,
      thumbnailUrl: sp.thumbnail_url,
      stockQuantity: Number(sp.stock_quantity),
      maxOrderQty: Number(sp.max_order_qty),
      subtotal: lineTotal,
      lineTotal,
      inStock: Number(sp.stock_quantity) > 0,
    }
  }
}
