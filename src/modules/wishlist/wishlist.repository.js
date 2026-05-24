import { query, getClient } from '../../config/database.js'

/**
 * Wishlist repository — database access for wishlist
 */
export class WishlistRepository {
  async getWishlist(userId) {
    const { rows } = await query(
      `SELECT w.id, w.product_id, w.created_at,
              p.name, p.slug, p.description, p.price, p.sale_price,
              p.category_id, p.stock_quantity, p.unit, p.thumbnail_url,
              p.images, p.tags, p.is_active, p.is_featured, p.total_sold,
              p.max_order_qty, p.ingredients, p.allergen_info, p.shelf_life,
              p.storage_instructions, p.certifications, p.nutrition_info,
              p.created_at AS product_created_at,
              c.name AS category_name
       FROM wishlist w
       JOIN products p ON w.product_id = p.id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
      [userId]
    )

    return {
      items: rows.map(row => ({
        id: row.product_id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        price: row.price,
        sale_price: row.sale_price,
        category_id: row.category_id,
        category_name: row.category_name,
        stock_quantity: row.stock_quantity,
        unit: row.unit,
        thumbnail_url: row.thumbnail_url || row.images?.[0] || null,
        images: row.images || [],
        tags: row.tags || [],
        is_featured: row.is_featured,
        total_sold: row.total_sold || 0,
        max_order_qty: row.max_order_qty,
        ingredients: row.ingredients,
        allergen_info: row.allergen_info,
        shelf_life: row.shelf_life,
        storage_instructions: row.storage_instructions,
        certifications: row.certifications,
        nutrition_info: row.nutrition_info,
        is_active: row.is_active,
        created_at: row.product_created_at,
        wishlist_entry_id: row.id,
        wishlist_added_at: row.created_at,
      })),
      total: rows.length,
    }
  }

  async getProduct(productId) {
    const { rows } = await query(
      'SELECT id, is_active FROM products WHERE id = $1',
      [productId]
    )
    return rows[0] ? { ...rows[0], is_available: rows[0].is_active } : null
  }

  async checkWishlistItem(userId, productId) {
    const { rows } = await query(
      'SELECT id FROM wishlist WHERE user_id = $1 AND product_id = $2',
      [userId, productId]
    )
    return rows.length > 0
  }

  async addItem(userId, productId) {
    const { rows } = await query(
      'INSERT INTO wishlist (user_id, product_id) VALUES ($1, $2) RETURNING id, product_id, created_at',
      [userId, productId]
    )
    return rows[0]
  }

  async removeItem(userId, productId) {
    await query(
      'DELETE FROM wishlist WHERE user_id = $1 AND product_id = $2',
      [userId, productId]
    )
  }

  async clearWishlist(userId) {
    await query('DELETE FROM wishlist WHERE user_id = $1', [userId])
  }

  /**
   * Page through users who have wishlisted a specific product. Used by the
   * stock-notifications BullMQ worker (task 13.2) to fan out restock push
   * notifications to interested customers (Requirements 3.4, 11.6).
   *
   * Keyset cursor on `user_id` keeps memory bounded on the 2-core/4GB
   * target box and avoids OFFSET scans on large wishlists. The caller
   * drives the loop until fewer than `limit` rows come back.
   *
   * Index note: the unique index `idx_wishlist_user_product (user_id,
   * product_id)` covers the (user_id) ordering; Postgres falls back to a
   * bitmap/sequential scan for the product_id predicate. Acceptable for
   * the restock-notification path which fires only on stock 0→positive
   * transitions (low frequency, small per-product wishlist sizes).
   *
   * @param {string} productId
   * @param {object} [opts]
   * @param {string|null} [opts.afterUserId] - Keyset cursor; pass the
   *   `user_id` of the last row from the previous batch (or null/undefined
   *   to start from the beginning).
   * @param {number} [opts.limit=200] - Page size; clamped to [1, 1000].
   * @returns {Promise<Array<{user_id: string}>>}
   */
  async findUsersByWishlistedProduct(productId, { afterUserId, limit } = {}) {
    // Resolve limit: invalid (NaN / non-numeric) → default 200, otherwise
    // clamp into [1, 1000] so callers can't accidentally request 0 /
    // negative / huge pages.
    const rawLimit = Number(limit)
    const resolvedLimit = Number.isFinite(rawLimit) ? rawLimit : 200
    const safeLimit = Math.max(1, Math.min(1000, resolvedLimit))
    const params = [productId]
    let where = 'WHERE w.product_id = $1'

    if (afterUserId) {
      params.push(afterUserId)
      where += ` AND w.user_id > $${params.length}`
    }

    params.push(safeLimit)
    const { rows } = await query(
      `SELECT w.user_id
       FROM wishlist w
       ${where}
       ORDER BY w.user_id ASC
       LIMIT $${params.length}`,
      params
    )

    return rows
  }

  async moveToCart(userId, items) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      let movedCount = 0
      for (const item of items) {
        if (item.is_active && Number(item.stock_quantity) > 0) {
          const existing = await client.query(
            'SELECT id, quantity FROM cart_items WHERE user_id = $1 AND product_id = $2',
            [userId, item.id]
          )

          if (existing.rows.length > 0) {
            await client.query(
              'UPDATE cart_items SET quantity = quantity + 1, updated_at = NOW() WHERE id = $1',
              [existing.rows[0].id]
            )
          } else {
            await client.query(
              'INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, 1)',
              [userId, item.id]
            )
          }
          movedCount++
        }
      }

      await client.query('COMMIT')
      return movedCount
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
