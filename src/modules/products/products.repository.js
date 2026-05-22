import { query } from '../../config/database.js'

function emptyPagination(page, limit) {
  return {
    data: [],
    pagination: {
      page,
      limit,
      total: 0,
      totalPages: 0,
    },
  }
}

function normalizeSearchTerms(q) {
  return String(q || '')
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean)
}

/**
 * Products repository — all SQL queries for products
 * NEVER uses SELECT * — always named columns
 */
export class ProductsRepository {
  /**
   * List products with filtering, sorting, pagination
   */
  async findMany({ page = 1, limit = 20, category, search, status, sort, minPrice, maxPrice, inStock }) {
    const offset = (page - 1) * limit
    const conditions = []
    const params = []
    let paramIdx = 1

    // Status filter (for admin dashboard)
    if (status === 'active') {
      conditions.push('p.is_active = true')
    } else if (status === 'inactive') {
      conditions.push('p.is_active = false')
    } else if (status === 'out_of_stock') {
      conditions.push('p.stock_quantity = 0')
    } else if (status === 'low_stock') {
      conditions.push('p.stock_quantity > 0 AND p.stock_quantity <= p.low_stock_threshold')
    } else if (status === 'on_sale') {
      conditions.push('p.sale_price IS NOT NULL AND p.sale_price < p.price')
    }

    if (category) {
      conditions.push(`p.category_id = $${paramIdx++}`)
      params.push(category)
    }

    if (search) {
      conditions.push(`(p.name ILIKE $${paramIdx} OR p.sku ILIKE $${paramIdx} OR p.barcode ILIKE $${paramIdx})`)
      params.push(`%${search}%`)
      paramIdx++
    }

    if (minPrice !== undefined) {
      conditions.push(`p.price >= $${paramIdx++}`)
      params.push(minPrice)
    }

    if (maxPrice !== undefined) {
      conditions.push(`p.price <= $${paramIdx++}`)
      params.push(maxPrice)
    }

    if (inStock === true || inStock === 'true') {
      conditions.push('p.stock_quantity > 0')
    } else if (inStock === false || inStock === 'false') {
      conditions.push('p.stock_quantity = 0')
    }

    const sortMap = {
      price_asc: 'p.price ASC',
      price_desc: 'p.price DESC',
      newest: 'p.created_at DESC',
      popular: 'p.total_sold DESC',
      name_asc: 'p.name ASC',
      name_desc: 'p.name DESC',
      stock_asc: 'p.stock_quantity ASC',
    }
    const orderBy = sortMap[sort] || 'p.created_at DESC'
    const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1'

    const { rows } = await query(
      `SELECT
        p.id, p.name, p.slug, p.price, p.sale_price,
        p.stock_quantity, p.unit, p.thumbnail_url,
        p.is_active, p.is_featured, p.total_sold,
        p.sku, p.barcode, p.low_stock_threshold, p.category_id,
        c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    )

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`,
      params
    )

    return {
      data: rows,
      pagination: {
        page,
        limit,
        total: countRows[0]?.total || 0,
        totalPages: Math.ceil((countRows[0]?.total || 0) / limit),
      },
    }
  }

  /**
   * Hybrid search: prefix full-text (simple dictionary) + ILIKE fallback
   * Uses 'simple' dictionary so prefix queries like 'amu:*' match 'amul'
   * without English stemming issues. Returns fuzzy suggestions when 0 results.
   */
  async fullTextSearch(q, { page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    const trimmed = String(q || '').trim()
    const searchTerms = normalizeSearchTerms(trimmed)

    if (!trimmed || searchTerms.length === 0) {
      return { ...emptyPagination(page, limit), suggestions: [] }
    }

    const prefixTsQuery = searchTerms.map((term) => `${term}:*`).join(' & ')
    const likePattern = `%${trimmed}%`

    const sql = `
      WITH fts AS (
        SELECT
          p.id,
          p.name,
          p.slug,
          p.price,
          p.sale_price,
          p.stock_quantity,
          p.unit,
          p.thumbnail_url,
          c.name AS category_name,
          p.is_featured,
          p.total_sold,
          ts_rank(p.search_vector, to_tsquery('simple', $1)) AS rank,
          1 AS source
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = true
          AND p.search_vector @@ to_tsquery('simple', $1)
      ),
      ilike_fallback AS (
        SELECT
          p.id,
          p.name,
          p.slug,
          p.price,
          p.sale_price,
          p.stock_quantity,
          p.unit,
          p.thumbnail_url,
          c.name AS category_name,
          p.is_featured,
          p.total_sold,
          0.1 AS rank,
          2 AS source
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = true
          AND p.id NOT IN (SELECT id FROM fts)
          AND (
            p.name ILIKE $2
            OR p.sku ILIKE $2
            OR p.barcode ILIKE $2
          )
      ),
      combined AS (
        SELECT * FROM fts
        UNION ALL
        SELECT * FROM ilike_fallback
      )
      SELECT
        id,
        name,
        slug,
        price,
        sale_price,
        stock_quantity,
        unit,
        thumbnail_url,
        category_name,
        is_featured,
        total_sold,
        rank
      FROM combined
      ORDER BY source ASC, rank DESC, total_sold DESC, name ASC
      LIMIT $3 OFFSET $4
    `

    const countSql = `
      SELECT COUNT(DISTINCT id)::int AS total
      FROM (
        SELECT p.id
        FROM products p
        WHERE p.is_active = true
          AND p.search_vector @@ to_tsquery('simple', $1)
        UNION
        SELECT p.id
        FROM products p
        WHERE p.is_active = true
          AND (
            p.name ILIKE $2
            OR p.sku ILIKE $2
            OR p.barcode ILIKE $2
          )
      ) AS matches
    `

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(sql, [prefixTsQuery, likePattern, limit, offset]),
      query(countSql, [prefixTsQuery, likePattern]),
    ])

    const total = countRows[0]?.total || 0

    // When no exact/prefix results, provide fuzzy nearest-match suggestions
    let suggestions = []
    if (rows.length === 0 && trimmed.length >= 2) {
      suggestions = await this.fuzzySuggest(trimmed)
    }

    return {
      data: rows,
      suggestions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  /**
   * Fuzzy suggestions using pg_trgm similarity.
   * Returns nearest products when exact/prefix search finds nothing.
   * Requires: CREATE EXTENSION pg_trgm (migration 017)
   */
  async fuzzySuggest(q, limit = 6) {
    try {
      const { rows } = await query(
        `SELECT p.id, p.name, p.slug, p.price, p.sale_price,
                p.stock_quantity, p.unit, p.thumbnail_url,
                c.name AS category_name,
                p.is_featured, p.total_sold,
                similarity(p.name, $1) AS sim
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.is_active = true
           AND similarity(p.name, $1) > 0.08
         ORDER BY sim DESC, p.total_sold DESC
         LIMIT $2`,
        [q, limit]
      )
      return rows
    } catch {
      // pg_trgm not available — return empty gracefully
      return []
    }
  }

  /**
   * Get featured/bestseller products
   */
  async findFeatured(limit = 20) {
    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, p.price, p.sale_price,
              p.stock_quantity, p.unit, p.thumbnail_url,
              c.name AS category_name, p.total_sold
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = true AND p.is_featured = true
       ORDER BY p.total_sold DESC
       LIMIT $1`,
      [limit]
    )
    return rows
  }

  /**
   * Get single product with full details
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, p.description, p.price, p.sale_price,
              p.cost_price, p.category_id, p.stock_quantity, p.unit,
              p.thumbnail_url, p.images, p.tags, p.is_active,
              p.is_featured, p.total_sold,
              p.sku, p.barcode, p.low_stock_threshold, p.max_order_qty,
              p.ingredients, p.allergen_info, p.shelf_life, p.storage_instructions,
              p.certifications, p.nutrition_info,
              p.meta_title, p.meta_description,
              p.brand, p.brand_logo_url, p.net_quantity, p.highlights, p.attributes,
              p.vendor_name, p.vendor_address, p.vendor_fssai, p.return_policy,
              p.avg_rating, p.rating_count, p.is_authentic,
              c.name AS category_name,
              (SELECT json_agg(v) FROM product_variants v WHERE v.product_id = p.id) AS variants,
              p.created_at, p.updated_at
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Get product by slug (public-facing)
   */
  async findBySlug(slug) {
    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, p.description, p.price, p.sale_price,
              p.cost_price, p.category_id, p.stock_quantity, p.unit,
              p.thumbnail_url, p.images, p.tags, p.is_active,
              p.is_featured, p.total_sold,
              p.sku, p.barcode, p.low_stock_threshold, p.max_order_qty,
              p.ingredients, p.allergen_info, p.shelf_life, p.storage_instructions,
              p.certifications, p.nutrition_info,
              p.meta_title, p.meta_description,
              p.brand, p.brand_logo_url, p.net_quantity, p.highlights, p.attributes,
              p.vendor_name, p.vendor_address, p.vendor_fssai, p.return_policy,
              p.avg_rating, p.rating_count, p.is_authentic,
              c.name AS category_name,
              (SELECT json_agg(v) FROM product_variants v WHERE v.product_id = p.id) AS variants,
              p.created_at, p.updated_at
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.slug = $1 AND p.is_active = true`,
      [slug]
    )
    return rows[0] || null
  }

  /**
   * Get related products (same category, excluding current)
   */
  async findRelated(productId, categoryId, limit = 10) {
    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, p.price, p.sale_price,
              p.stock_quantity, p.unit, p.thumbnail_url, p.total_sold
       FROM products p
       WHERE p.is_active = true
         AND p.category_id = $1
         AND p.id != $2
       ORDER BY p.total_sold DESC
       LIMIT $3`,
      [categoryId, productId, limit]
    )
    return rows
  }

  async findPairWith(productId, categoryId, limit = 10) {
    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, p.price, p.sale_price,
              p.stock_quantity, p.unit, p.thumbnail_url,
              p.brand, p.total_sold, p.avg_rating, p.rating_count,
              c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = true
         AND p.category_id != $1
         AND p.id != $2
       ORDER BY p.total_sold DESC
       LIMIT $3`,
      [categoryId, productId, limit]
    )
    return rows
  }

  /**
   * Create a new product
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO products
        (name, slug, description, price, sale_price, cost_price,
         category_id, stock_quantity, unit, thumbnail_url, images, tags,
         is_featured, is_active, sku, barcode, low_stock_threshold, max_order_qty,
         ingredients, allergen_info, shelf_life, storage_instructions,
         certifications, nutrition_info, meta_title, meta_description,
         brand, brand_logo_url, net_quantity, highlights, attributes,
         vendor_name, vendor_address, vendor_fssai, return_policy,
         avg_rating, rating_count, is_authentic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
       RETURNING id, name, slug, price, sale_price, stock_quantity, unit,
                 thumbnail_url, category_id, is_featured, is_active, sku, created_at`,
      [
        data.name, data.slug, data.description || null,
        data.price, data.salePrice || null, data.costPrice || null,
        data.categoryId, data.stock || 0, data.unit || 'piece',
        data.thumbnailUrl || null, JSON.stringify(data.images || []),
        data.tags || [], data.isFeatured || false, data.isActive !== false,
        data.sku || null, data.barcode || null,
        data.lowStockThreshold || 10, data.maxOrderQty || null,
        data.ingredients || null, data.allergenInfo || null,
        data.shelfLife || null, data.storageInstructions || null,
        data.certifications || null,
        data.nutritionInfo ? data.nutritionInfo : null,
        data.metaTitle || null, data.metaDescription || null,
        data.brand || null, data.brandLogoUrl || null,
        data.netQuantity || null, JSON.stringify(data.highlights || {}),
        JSON.stringify(data.attributes || []),
        data.vendorName || null, data.vendorAddress || null,
        data.vendorFssai || null, data.returnPolicy || 'no_return',
        data.avgRating ?? 0, data.ratingCount ?? 0,
        data.isAuthentic !== false,
      ]
    )

    if (data.variants && data.variants.length > 0) {
      await this.saveVariants(rows[0].id, data.variants)
    }

    return rows[0]
  }

  /**
   * Update product fields
   */
  async update(id, data) {
    const fieldMap = {
      name: 'name', description: 'description', price: 'price',
      salePrice: 'sale_price', costPrice: 'cost_price',
      categoryId: 'category_id', stock: 'stock_quantity',
      unit: 'unit', thumbnailUrl: 'thumbnail_url',
      isFeatured: 'is_featured', isActive: 'is_active', slug: 'slug',
      sku: 'sku', barcode: 'barcode',
      lowStockThreshold: 'low_stock_threshold', maxOrderQty: 'max_order_qty',
      ingredients: 'ingredients', allergenInfo: 'allergen_info',
      shelfLife: 'shelf_life', storageInstructions: 'storage_instructions',
      metaTitle: 'meta_title', metaDescription: 'meta_description',
      brand: 'brand', brandLogoUrl: 'brand_logo_url',
      netQuantity: 'net_quantity', vendorName: 'vendor_name',
      vendorAddress: 'vendor_address', vendorFssai: 'vendor_fssai',
      returnPolicy: 'return_policy', isAuthentic: 'is_authentic',
      avgRating: 'avg_rating', ratingCount: 'rating_count',
    }

    const fields = []
    const params = []
    let idx = 1

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey] === '' ? null : data[jsKey])
      }
    }

    // Handle JSON/array fields separately
    if (data.images !== undefined) {
      fields.push(`images = $${idx++}`)
      params.push(JSON.stringify(data.images))
    }
    if (data.tags !== undefined) {
      fields.push(`tags = $${idx++}`)
      params.push(data.tags)
    }
    if (data.highlights !== undefined) {
      fields.push(`highlights = $${idx++}`)
      params.push(JSON.stringify(data.highlights))
    }
    if (data.attributes !== undefined) {
      fields.push(`attributes = $${idx++}`)
      params.push(JSON.stringify(data.attributes))
    }
    if (data.certifications !== undefined) {
      fields.push(`certifications = $${idx++}`)
      params.push(data.certifications)
    }
    if (data.variants !== undefined) {
      await this.saveVariants(id, data.variants)
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, slug, price, sale_price, stock_quantity, unit,
                 thumbnail_url, category_id, is_featured, is_active, updated_at`,
      params
    )
    return rows[0]
  }

  /**
   * Helper to save variants (deletes existing and inserts new)
   */
  async saveVariants(productId, variants) {
    if (!variants) return

    // Clear old variants
    await query(`DELETE FROM product_variants WHERE product_id = $1`, [productId])

    if (variants.length === 0) return

    // Insert new variants
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i]
      await query(
        `INSERT INTO product_variants
          (product_id, name, sku, price, sale_price, stock, display_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          productId,
          v.name || ("Variant " + (i + 1)),
          v.sku || null,
          v.price || 0,
          v.salePrice || null,
          v.stockQuantity ?? v.stock ?? 0,
          i,
          v.isActive !== false
        ]
      )
    }
  }

  /**
   * Update stock quantity only
   */
  async updateStock(id, stock) {
    const { rows } = await query(
      `UPDATE products SET stock_quantity = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name, stock_quantity`,
      [stock, id]
    )
    return rows[0]
  }

  /**
   * Soft-delete product
   */
  async delete(id) {
    await query(
      `UPDATE products SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id]
    )
  }

  /**
   * Find products with active price drops (sale_price < price)
   * Used in cart "Price Drop Alert" section
   */
  async getPriceDrops(limit = 10) {
    const { rows } = await query(
      `SELECT id, name, thumbnail_url, price, sale_price, unit, stock_quantity,
              (price - sale_price) AS discount
       FROM products p
       WHERE is_active = true
         AND sale_price IS NOT NULL
         AND sale_price < price
       ORDER BY discount DESC
       LIMIT $1`,
      [limit]
    )
    return rows
  }

  /**
   * Find last-minute / cafe / snack products
   * Used in cart "Last-Minute Cravings" section
   */
  async getLastMinute(limit = 10) {
    const { rows } = await query(
      `SELECT p.id, p.name, p.thumbnail_url, p.price, p.sale_price, p.unit
       FROM products p
       JOIN categories c ON p.category_id = c.id
       WHERE p.is_active = true
         AND p.price <= 150
         AND (c.slug IN ('snacks','cafe','bakery','sweets','beverages')
              OR c.name ILIKE '%cafe%'
              OR c.name ILIKE '%snack%')
       ORDER BY p.sale_price ASC NULLS LAST
       LIMIT $1`,
      [limit]
    )
    return rows
  }

  async findPriceDrops(limit = 10) {
    return this.getPriceDrops(limit)
  }

  async findLastMinute(limit = 10) {
    return this.getLastMinute(limit)
  }
}
