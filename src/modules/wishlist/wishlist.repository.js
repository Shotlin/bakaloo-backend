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
