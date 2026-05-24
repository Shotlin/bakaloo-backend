import { query } from '../../config/database.js'

/**
 * Shop Products repository — all SQL queries for shop_products
 *
 * Conventions:
 *   - NEVER `SELECT *` — every column is named explicitly
 *   - All queries use parameterized placeholders ($1, $2…)
 *   - Mutations that need row-level locks (stock updates) are executed against
 *     a transaction client passed in by the service. The plain `query()` helper
 *     uses a fresh pool client per call and cannot hold a transaction.
 *
 * Migration reference: src/database/migrations/031_shop_products.sql
 */
export class ShopProductsRepository {
  // ────────────────────────────────────────────────────────
  // Column projections — keep these in sync with the schema
  // ────────────────────────────────────────────────────────
  static SELECT_COLUMNS = `
    id, shop_id, product_id,
    price, sale_price, cost_price,
    stock_quantity, low_stock_threshold, max_order_qty,
    is_available, sold_out_at,
    deleted_at, created_at, updated_at
  `

  /**
   * Insert a new shop_product row.
   * @param {object} data - Validated fields
   * @returns {Promise<object>} Created record
   */
  async create(data) {
    const soldOutAt =
      data.stock_quantity === 0 && data.is_available === false
        ? new Date()
        : null

    const { rows } = await query(
      `INSERT INTO shop_products (
        shop_id, product_id,
        price, sale_price, cost_price,
        stock_quantity, low_stock_threshold, max_order_qty,
        is_available, sold_out_at
      ) VALUES (
        $1, $2,
        $3, $4, $5,
        $6, $7, $8,
        $9, $10
      )
      RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      [
        data.shop_id,
        data.product_id,
        data.price ?? null,
        data.sale_price ?? null,
        data.cost_price ?? null,
        data.stock_quantity,
        data.low_stock_threshold,
        data.max_order_qty,
        data.is_available,
        soldOutAt,
      ]
    )
    return rows[0]
  }

  /**
   * Find a shop_product by id, scoped to a shop (excludes soft-deleted).
   * Uses idx_shop_products_shop_available (shop_id, is_available).
   * @param {string} id - shop_product UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @returns {Promise<object|null>}
   */
  async findById(id, shopId) {
    const { rows } = await query(
      `SELECT ${ShopProductsRepository.SELECT_COLUMNS}
        FROM shop_products
        WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
      [id, shopId]
    )
    return rows[0] || null
  }

  /**
   * Find an existing shop_product by (shop_id, product_id).
   * Used for duplicate detection on create. Includes soft-deleted records so
   * the caller can decide whether to undelete or reject.
   * Uses uq_shop_products_shop_product unique index.
   * @param {string} shopId
   * @param {string} productId
   * @returns {Promise<object|null>}
   */
  async findByShopAndProduct(shopId, productId) {
    const { rows } = await query(
      `SELECT ${ShopProductsRepository.SELECT_COLUMNS}
        FROM shop_products
        WHERE shop_id = $1 AND product_id = $2`,
      [shopId, productId]
    )
    return rows[0] || null
  }

  /**
   * List shop_products for a shop with filters and pagination.
   * Single LEFT JOIN to products avoids N+1 lookups for product names.
   * Filters use idx_shop_products_shop_available (shop_id, is_available).
   *
   * @param {object} filters
   * @param {string} filters.shopId
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=20]
   * @param {string} [filters.is_available] - 'true' | 'false'
   * @param {string} [filters.low_stock] - 'true' | 'false'
   * @param {string} [filters.search] - Search by product name
   * @param {boolean} [filters.includeDeleted=false]
   * @returns {Promise<{items: Array, total: number}>}
   */
  async findMany({
    shopId,
    page = 1,
    limit = 20,
    is_available,
    low_stock,
    search,
    includeDeleted = false,
  }) {
    const offset = (page - 1) * limit
    const conditions = ['sp.shop_id = $1']
    const params = [shopId]
    let paramIdx = 2

    if (!includeDeleted) {
      conditions.push('sp.deleted_at IS NULL')
    }

    if (is_available === 'true') {
      conditions.push('sp.is_available = true')
    } else if (is_available === 'false') {
      conditions.push('sp.is_available = false')
    }

    if (low_stock === 'true') {
      conditions.push('sp.stock_quantity <= sp.low_stock_threshold')
    }

    if (search) {
      conditions.push(`p.name ILIKE $${paramIdx++}`)
      params.push(`%${search}%`)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT
          sp.id, sp.shop_id, sp.product_id,
          sp.price, sp.sale_price, sp.cost_price,
          sp.stock_quantity, sp.low_stock_threshold, sp.max_order_qty,
          sp.is_available, sp.sold_out_at,
          sp.deleted_at, sp.created_at, sp.updated_at,
          p.name AS product_name,
          -- products.images is JSONB (array of URLs). Take the first element
          -- as the thumbnail; the column was renamed from image_url at some
          -- point and the SELECT was never updated. Falls back to NULL when
          -- the array is empty or missing.
          (p.images->>0) AS product_image_url
        FROM shop_products sp
        LEFT JOIN products p ON p.id = sp.product_id
        WHERE ${where}
        ORDER BY sp.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
        FROM shop_products sp
        LEFT JOIN products p ON p.id = sp.product_id
        WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Update a shop_product (excluding stock_quantity — see applyStockUpdate).
   * Scoped to shop_id; fails (returns null) if record is missing or soft-deleted.
   * @param {string} id - shop_product UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @param {object} data - Fields to update
   * @returns {Promise<object|null>}
   */
  async update(id, shopId, data) {
    const fields = []
    const params = []
    let idx = 1

    const updatable = [
      'price',
      'sale_price',
      'cost_price',
      'low_stock_threshold',
      'max_order_qty',
      'is_available',
    ]

    for (const key of updatable) {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${idx++}`)
        params.push(data[key])
      }
    }

    if (fields.length === 0) {
      return this.findById(id, shopId)
    }

    fields.push('updated_at = NOW()')
    params.push(id, shopId)

    const { rows } = await query(
      `UPDATE shop_products SET ${fields.join(', ')}
       WHERE id = $${idx} AND shop_id = $${idx + 1} AND deleted_at IS NULL
       RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      params
    )
    return rows[0] || null
  }

  /**
   * Soft-delete a shop_product (deleted_at = NOW()).
   * @param {string} id
   * @param {string} shopId
   * @returns {Promise<boolean>}
   */
  async softDelete(id, shopId) {
    const { rowCount } = await query(
      `UPDATE shop_products
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
      [id, shopId]
    )
    return rowCount > 0
  }

  /**
   * Look up the product name for a shop_product row. Used by post-commit
   * side effects (Socket.IO emission, push notifications) so we can include
   * a human-readable name in the payload without a separate fetch on every
   * caller.
   *
   * Returns null when the row is missing, soft-deleted, or has no joined
   * product (defensive — products are FK NOT NULL today, but we don't want
   * the side-effect path to crash when the catalog row was archived).
   *
   * Uses the shop_products PK and the products PK — no full scan.
   *
   * @param {string} id - shop_product UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @returns {Promise<{product_name: string|null, product_id: string}|null>}
   */
  async findProductMetaById(id, shopId) {
    const { rows } = await query(
      `SELECT sp.product_id, p.name AS product_name
        FROM shop_products sp
        LEFT JOIN products p ON p.id = sp.product_id
        WHERE sp.id = $1 AND sp.shop_id = $2 AND sp.deleted_at IS NULL`,
      [id, shopId]
    )
    return rows[0] || null
  }

  // ────────────────────────────────────────────────────────
  // Transactional helpers — caller passes a pg Client that owns BEGIN
  // ────────────────────────────────────────────────────────

  /**
   * Lock a shop_product row for update inside a transaction.
   * Used by stock-update flows (Requirement 3.8, 11.7).
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {string} shopId
   * @returns {Promise<object|null>}
   */
  async findByIdForUpdate(client, id, shopId) {
    const { rows } = await client.query(
      `SELECT ${ShopProductsRepository.SELECT_COLUMNS}
        FROM shop_products
        WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [id, shopId]
    )
    return rows[0] || null
  }

  /**
   * Apply a stock-quantity write inside an open transaction.
   * Caller is responsible for ensuring the row was locked first via
   * findByIdForUpdate, and that newStockQuantity >= 0 (the DB CHECK constraint
   * enforces this defensively, but the service guards beforehand for nicer
   * error codes — Requirements 3.5, 3.8, 11.7).
   *
   * Also updates is_available and sold_out_at according to the transition
   * (Requirements 3.3, 3.4, 11.1, 11.6):
   *   - new=0 → is_available=false, sold_out_at=NOW()
   *   - new>0 AND prev was 0 → is_available=true,  sold_out_at=NULL
   *   - otherwise: leave is_available/sold_out_at untouched
   *
   * Note: The CASE expressions reference only the parameter $1 (newQty) and
   * existing column values. No user input is interpolated into SQL text.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {string} shopId
   * @param {number} newStockQuantity
   * @returns {Promise<object|null>}
   */
  async applyStockUpdate(client, id, shopId, newStockQuantity) {
    const { rows } = await client.query(
      `UPDATE shop_products
       SET stock_quantity = $1,
           is_available = CASE
             WHEN $1 = 0 THEN false
             WHEN stock_quantity = 0 AND $1 > 0 THEN true
             ELSE is_available
           END,
           sold_out_at = CASE
             WHEN $1 = 0 THEN NOW()
             WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
             ELSE sold_out_at
           END,
           updated_at = NOW()
       WHERE id = $2 AND shop_id = $3 AND deleted_at IS NULL
       RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      [newStockQuantity, id, shopId]
    )
    return rows[0] || null
  }
}
