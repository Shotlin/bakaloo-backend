import { query } from '../../config/database.js'

/**
 * Categories repository — all SQL queries for categories
 */
export class CategoriesRepository {
  /**
   * Get all active categories ordered by sort_order
   */
  async findAll() {
    const { rows } = await query(
      `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.parent_id, c.sort_order, c.is_active, c.created_at,
              (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id AND p.is_active = true) AS product_count
       FROM categories c
       ORDER BY c.sort_order ASC, c.name ASC`
    )
    return rows
  }

  /**
   * Find a single category by ID
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT id, name, slug, description, image_url, parent_id, sort_order, is_active, created_at, updated_at
       FROM categories WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Find a category by slug
   */
  async findBySlug(slug) {
    const { rows } = await query(
      `SELECT id FROM categories WHERE slug = $1`,
      [slug]
    )
    return rows[0] || null
  }

  /**
   * Create a new category
   */
  async create({ name, slug, description, image_url, parent_id, sort_order, is_active }) {
    const { rows } = await query(
      `INSERT INTO categories (name, slug, description, image_url, parent_id, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, slug, description, image_url, parent_id, sort_order, is_active, created_at`,
      [name, slug, description || null, image_url || null, parent_id || null, sort_order || 0, is_active !== false]
    )
    return rows[0]
  }

  /**
   * Update a category — only provided fields
   */
  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1

    const allowed = ['name', 'slug', 'description', 'image_url', 'parent_id', 'sort_order', 'is_active']
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${idx++}`)
        params.push(data[key])
      }
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE categories SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, slug, description, image_url, parent_id, sort_order, is_active, created_at, updated_at`,
      params
    )
    return rows[0]
  }

  /**
   * Soft-delete: deactivate a category
   */
  async delete(id) {
    await query(
      `UPDATE categories SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id]
    )
  }

  /**
   * Get products belonging to a category (paginated)
   */
  async findProducts(categoryId, { limit, offset, sort, inStock }) {
    const conditions = ['p.is_active = true', 'p.category_id = $1']
    const params = [categoryId]
    let paramIdx = 2

    if (inStock) {
      conditions.push('p.stock_quantity > 0')
    }

    const sortMap = {
      price_asc: 'p.price ASC',
      price_desc: 'p.price DESC',
      newest: 'p.created_at DESC',
      popular: 'p.total_sold DESC',
    }
    const orderBy = sortMap[sort] || 'p.created_at DESC'
    const where = conditions.join(' AND ')

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, p.price, p.sale_price, p.stock_quantity,
              p.unit, p.thumbnail_url, p.is_featured, p.total_sold
       FROM products p
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    )

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`,
      params
    )

    return { data: rows, total: countRows[0]?.total || 0 }
  }
}
