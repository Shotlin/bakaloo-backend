import { redis } from '../../config/redis.js'
import { query } from '../../config/database.js'

const CART_PREFIX = 'cart:'
const CART_TTL = 60 * 60 * 24 * 7 // 7 days
const CART_TIP_PREFIX = 'cart-tip:'
const CART_INSTRUCTIONS_PREFIX = 'cart-instructions:'

/**
 * Cart repository — Redis for cart data, PostgreSQL for product lookups
 */
export class CartRepository {
  /**
   * Get all items in user's cart from Redis
   */
  async getCart(userId) {
    const data = await redis.get(`${CART_PREFIX}${userId}`)
    if (!data) return []
    try {
      return JSON.parse(data)
    } catch {
      return []
    }
  }

  /**
   * Save entire cart to Redis
   */
  async saveCart(userId, items) {
    await redis.set(
      `${CART_PREFIX}${userId}`,
      JSON.stringify(items),
      'EX',
      CART_TTL
    )
  }

  /**
   * Clear cart
   */
  async clearCart(userId) {
    await redis.del(`${CART_PREFIX}${userId}`)
  }

  /**
   * Look up a product by ID (for stock/price checks)
   */
  async findProduct(productId) {
    const { rows } = await query(
      `SELECT id, name, slug, price, sale_price, stock_quantity, unit, thumbnail_url, is_active
       FROM products
       WHERE id = $1`,
      [productId]
    )
    return rows[0] || null
  }

  /**
   * Look up multiple products by IDs
   */
  async findProductsByIds(productIds) {
    if (productIds.length === 0) return []
    const { rows } = await query(
      `SELECT id, name, slug, price, sale_price, stock_quantity, unit, thumbnail_url, is_active
       FROM products
       WHERE id = ANY($1)`,
      [productIds]
    )
    return rows
  }

  // ─── Cart Extras (Tip & Instructions) ─────────────

  /**
   * Get tip amount from Redis
   */
  async getTip(userId) {
    const tip = await redis.get(`${CART_TIP_PREFIX}${userId}`)
    return tip ? parseFloat(tip) : 0
  }

  /**
   * Set tip amount in Redis (7-day TTL)
   */
  async setTip(userId, amount) {
    await redis.set(`${CART_TIP_PREFIX}${userId}`, String(amount), 'EX', CART_TTL)
  }

  /**
   * Clear tip amount
   */
  async clearTip(userId) {
    await redis.del(`${CART_TIP_PREFIX}${userId}`)
  }

  /**
   * Get delivery instructions from Redis
   */
  async getInstructions(userId) {
    return await redis.get(`${CART_INSTRUCTIONS_PREFIX}${userId}`) || null
  }

  /**
   * Set delivery instructions in Redis (7-day TTL)
   */
  async setInstructions(userId, text) {
    if (text && text.trim()) {
      await redis.set(`${CART_INSTRUCTIONS_PREFIX}${userId}`, text.trim(), 'EX', CART_TTL)
    } else {
      await this.clearInstructions(userId)
    }
  }

  /**
   * Clear delivery instructions
   */
  async clearInstructions(userId) {
    await redis.del(`${CART_INSTRUCTIONS_PREFIX}${userId}`)
  }

  /**
   * Backward-compatible alias for existing callers
   */
  async getDeliveryInstructions(userId) {
    return this.getInstructions(userId)
  }

  /**
   * Backward-compatible alias for existing callers
   */
  async setDeliveryInstructions(userId, instructions) {
    await this.setInstructions(userId, instructions)
  }

  /**
   * Clear tip and instructions on order placement
   */
  async clearExtras(userId) {
    await Promise.all([
      this.clearTip(userId),
      this.clearInstructions(userId),
    ])
  }
}
