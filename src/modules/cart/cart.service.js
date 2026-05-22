import { logger } from '../../config/logger.js'

/**
 * Cart service — business logic for Redis-backed cart
 */
export class CartService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Get enriched cart with current product data
   */
  async getCart(userId) {
    const cartItems = await this.repo.getCart(userId)
    if (cartItems.length === 0) {
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
      }
    }
    return this._enrichCart(userId, cartItems)
  }

  /**
   * Add item to cart (or increment quantity if already exists)
   */
  async addItem(userId, { productId, quantity }) {
    const product = await this.repo.findProduct(productId)
    if (!product || !product.is_active) {
      return { success: false, message: 'Product not found or unavailable' }
    }

    const cartItems = await this.repo.getCart(userId)
    const existingIndex = cartItems.findIndex((i) => i.productId === productId)

    let newQty = quantity
    if (existingIndex >= 0) {
      newQty = cartItems[existingIndex].quantity + quantity
      cartItems[existingIndex].quantity = newQty
    } else {
      cartItems.push({ productId, quantity })
    }

    if (newQty > product.stock_quantity) {
      return {
        success: false,
        message: `Only ${product.stock_quantity} units available for "${product.name}"`,
      }
    }

    await this.repo.saveCart(userId, cartItems)
    logger.info({ userId, productId, quantity: newQty }, 'Cart item added/updated')

    return { success: true, cart: await this._enrichCart(userId, cartItems) }
  }

  /**
   * Update item quantity (absolute, not delta)
   */
  async updateItem(userId, productId, quantity) {
    const cartItems = await this.repo.getCart(userId)
    const index = cartItems.findIndex((i) => i.productId === productId)

    if (index === -1) {
      return { success: false, message: 'Item not in cart' }
    }

    const product = await this.repo.findProduct(productId)
    if (!product || !product.is_active) {
      cartItems.splice(index, 1)
      await this.repo.saveCart(userId, cartItems)
      return { success: false, message: 'Product is no longer available' }
    }

    if (quantity > product.stock_quantity) {
      return {
        success: false,
        message: `Only ${product.stock_quantity} units available for "${product.name}"`,
      }
    }

    cartItems[index].quantity = quantity
    await this.repo.saveCart(userId, cartItems)

    return { success: true, cart: await this._enrichCart(userId, cartItems) }
  }

  /**
   * Remove item from cart
   */
  async removeItem(userId, productId) {
    const cartItems = await this.repo.getCart(userId)
    const filtered = cartItems.filter((i) => i.productId !== productId)

    if (filtered.length === cartItems.length) {
      return { success: false, message: 'Item not in cart' }
    }

    await this.repo.saveCart(userId, filtered)
    return { success: true, cart: await this._enrichCart(userId, filtered) }
  }

  /**
   * Clear entire cart
   */
  async clearCart(userId) {
    await this.repo.clearCart(userId)
  }

  /**
   * Validate cart before checkout — check stock and prices are current
   */
  async validateCart(userId) {
    const cartItems = await this.repo.getCart(userId)
    if (cartItems.length === 0) {
      return { valid: false, items: [], subtotal: 0, warnings: ['Cart is empty'] }
    }

    const productIds = cartItems.map((i) => i.productId)
    const products = await this.repo.findProductsByIds(productIds)
    const productMap = new Map(products.map((p) => [p.id, p]))

    const warnings = []
    const validItems = []
    let subtotal = 0

    for (const item of cartItems) {
      const product = productMap.get(item.productId)

      if (!product || !product.is_active) {
        warnings.push(`"${item.productId}" is no longer available — removed`)
        continue
      }

      let qty = item.quantity
      if (qty > product.stock_quantity) {
        warnings.push(
          `"${product.name}" quantity adjusted from ${qty} to ${product.stock_quantity}`
        )
        qty = product.stock_quantity
      }

      if (qty === 0) {
        warnings.push(`"${product.name}" is out of stock — removed`)
        continue
      }

      const effectivePrice = product.sale_price ?? product.price
      const listPrice = parseFloat(product.price)
      const salePrice = product.sale_price ? parseFloat(product.sale_price) : null
      const lineTotal = parseFloat((effectivePrice * qty).toFixed(2))
      subtotal += lineTotal

      validItems.push({
        productId: product.id,
        name: product.name,
        slug: product.slug,
        price: listPrice,
        originalPrice: salePrice !== null && salePrice < listPrice ? listPrice : null,
        salePrice,
        quantity: qty,
        unit: product.unit,
        image: product.thumbnail_url,
        thumbnailUrl: product.thumbnail_url,
        stockQuantity: product.stock_quantity,
        subtotal: lineTotal,
        lineTotal,
        inStock: product.stock_quantity > 0,
      })
    }

    // Update cart with validated items
    await this.repo.saveCart(
      userId,
      validItems.map((i) => ({ productId: i.productId, quantity: i.quantity }))
    )

    return {
      valid: warnings.length === 0,
      items: validItems,
      subtotal: parseFloat(subtotal.toFixed(2)),
      warnings,
    }
  }

  /**
   * Enrich raw cart items with product data
   */
  async _enrichCart(userId, cartItems) {
    if (cartItems.length === 0) {
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
      }
    }

    const productIds = cartItems.map((i) => i.productId)
    const [products, tipAmount, deliveryInstructions] = await Promise.all([
      this.repo.findProductsByIds(productIds),
      this.repo.getTip(userId),
      this.repo.getInstructions(userId),
    ])
    const productMap = new Map(products.map((p) => [p.id, p]))

    let subtotal = 0
    let totalMrp = 0
    const items = []

    for (const item of cartItems) {
      const product = productMap.get(item.productId)
      if (!product || !product.is_active) continue

      const effectivePrice = product.sale_price ?? product.price
      const listPrice = parseFloat(product.price)
      const salePrice = product.sale_price ? parseFloat(product.sale_price) : null
      const lineTotal = parseFloat((effectivePrice * item.quantity).toFixed(2))
      subtotal += lineTotal
      totalMrp += listPrice * item.quantity

      items.push({
        productId: product.id,
        name: product.name,
        slug: product.slug,
        price: listPrice,
        originalPrice: salePrice !== null && salePrice < listPrice ? listPrice : null,
        salePrice,
        quantity: item.quantity,
        unit: product.unit,
        image: product.thumbnail_url,
        thumbnailUrl: product.thumbnail_url,
        stockQuantity: product.stock_quantity,
        subtotal: lineTotal,
        lineTotal,
        inStock: product.stock_quantity > 0 && item.quantity <= product.stock_quantity,
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
    }
  }
}
