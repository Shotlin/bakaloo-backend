import { query } from '../../config/database.js'

const COLUMNS = `
  id, scope, shop_id, target_type, category_id, product_id, label,
  max_qty_per_order, window_enabled, window_period, window_count,
  max_qty_per_window, exempt_order_cap_with_other_items, is_active,
  created_by, updated_by, created_at, updated_at
`

// Same columns as COLUMNS, qualified with the `r` alias. findAll/findById
// LEFT JOIN categories/products to pre-join their names — both of those
// tables also have an `id` column, so an unqualified `id` (or `created_at`,
// present on all three) is ambiguous to Postgres the moment the join is in
// scope. INSERT/UPDATE...RETURNING (create/update below) have no `r` alias
// available, so they keep using the unqualified COLUMNS.
const COLUMNS_R = `
  r.id, r.scope, r.shop_id, r.target_type, r.category_id, r.product_id, r.label,
  r.max_qty_per_order, r.window_enabled, r.window_period, r.window_count,
  r.max_qty_per_window, r.exempt_order_cap_with_other_items, r.is_active,
  r.created_by, r.updated_by, r.created_at, r.updated_at
`

const WINDOW_DAYS_PER_UNIT = { DAY: 1, WEEK: 7, MONTH: 30 }

/**
 * Purchase-limit rules repository.
 *
 * Every read method that participates in cart/checkout enforcement takes
 * an optional trailing `client` (a `pg.PoolClient` from an open
 * transaction). When provided (order-splitter.service.js, inside the
 * checkout transaction) queries run on that client so they see the
 * transaction's own writes and honor its advisory locks; when omitted
 * (cart.service.js, outside any transaction) they run on the shared pool.
 */
export class PurchaseLimitsRepository {
  _exec(client) {
    return client ? (text, params) => client.query(text, params) : query
  }

  // ────────────────────────────────────────────────────────
  // Admin CRUD
  // ────────────────────────────────────────────────────────

  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS_R},
              c.name AS category_name,
              p.name AS product_name
         FROM purchase_limit_rules r
         LEFT JOIN categories c ON c.id = r.category_id
         LEFT JOIN products   p ON p.id = r.product_id
        ORDER BY r.created_at DESC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(
      `SELECT ${COLUMNS_R},
              c.name AS category_name,
              p.name AS product_name
         FROM purchase_limit_rules r
         LEFT JOIN categories c ON c.id = r.category_id
         LEFT JOIN products   p ON p.id = r.product_id
        WHERE r.id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async create(data, actorId) {
    const { rows } = await query(
      `INSERT INTO purchase_limit_rules (
         scope, shop_id, target_type, category_id, product_id, label,
         max_qty_per_order, window_enabled, window_period, window_count,
         max_qty_per_window, exempt_order_cap_with_other_items, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       RETURNING ${COLUMNS}`,
      [
        data.scope || 'GLOBAL',
        data.shopId ?? null,
        data.targetType,
        data.targetType === 'CATEGORY' ? data.categoryId : null,
        data.targetType === 'PRODUCT' ? data.productId : null,
        data.label,
        data.maxQtyPerOrder ?? null,
        !!data.windowEnabled,
        data.windowEnabled ? data.windowPeriod : null,
        data.windowEnabled ? data.windowCount : null,
        data.windowEnabled ? data.maxQtyPerWindow : null,
        !!data.exemptOrderCapWithOtherItems,
        actorId ?? null,
      ]
    )
    return this._format(rows[0])
  }

  async update(id, data, actorId) {
    const fields = []
    const params = []
    let idx = 1

    const set = (column, value) => {
      fields.push(`${column} = $${idx++}`)
      params.push(value)
    }

    if (data.label !== undefined) set('label', data.label)
    if (data.maxQtyPerOrder !== undefined) set('max_qty_per_order', data.maxQtyPerOrder)
    if (data.windowEnabled !== undefined) {
      set('window_enabled', !!data.windowEnabled)
      set('window_period', data.windowEnabled ? data.windowPeriod : null)
      set('window_count', data.windowEnabled ? data.windowCount : null)
      set('max_qty_per_window', data.windowEnabled ? data.maxQtyPerWindow : null)
    }
    if (data.exemptOrderCapWithOtherItems !== undefined) {
      set('exempt_order_cap_with_other_items', !!data.exemptOrderCapWithOtherItems)
    }
    if (data.isActive !== undefined) set('is_active', data.isActive)

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    set('updated_by', actorId ?? null)
    params.push(id)

    const { rows } = await query(
      `UPDATE purchase_limit_rules SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async remove(id) {
    const result = await query(`DELETE FROM purchase_limit_rules WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  // ────────────────────────────────────────────────────────
  // Enforcement — used by cart.service.js and order-splitter.service.js
  // ────────────────────────────────────────────────────────

  /**
   * Resolves the single effective rule for each of `productIds`: the
   * PRODUCT-level rule if one is active for that product, else the
   * CATEGORY-level rule for that product's category, else absent
   * (absent == unrestricted, the safe default every caller relies on).
   *
   * @param {string[]} productIds
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Map<string, object>>} productId -> effective rule
   */
  async resolveEffectiveRules(productIds, client = null) {
    const ids = Array.from(new Set(productIds)).filter(Boolean)
    if (ids.length === 0) return new Map()

    const exec = this._exec(client)
    const { rows } = await exec(
      `WITH target_products AS (
         SELECT id AS product_id, category_id FROM products WHERE id = ANY($1::uuid[])
       ),
       matched AS (
         SELECT
           tp.product_id,
           r.id, r.label, r.target_type, r.category_id,
           r.product_id AS rule_product_id,
           r.max_qty_per_order, r.window_enabled, r.window_period,
           r.window_count, r.max_qty_per_window, r.exempt_order_cap_with_other_items,
           CASE r.target_type WHEN 'PRODUCT' THEN 0 ELSE 1 END AS precedence
         FROM target_products tp
         JOIN purchase_limit_rules r
           ON r.is_active = true
          AND r.scope = 'GLOBAL'
          AND (
               (r.target_type = 'PRODUCT'  AND r.product_id  = tp.product_id)
            OR (r.target_type = 'CATEGORY' AND r.category_id = tp.category_id AND tp.category_id IS NOT NULL)
              )
       )
       SELECT DISTINCT ON (product_id) *
       FROM matched
       ORDER BY product_id, precedence ASC`,
      [ids]
    )

    const map = new Map()
    for (const row of rows) {
      map.set(row.product_id, {
        id: row.id,
        label: row.label,
        targetType: row.target_type,
        categoryId: row.category_id,
        productId: row.rule_product_id,
        maxQtyPerOrder: row.max_qty_per_order != null ? Number(row.max_qty_per_order) : null,
        windowEnabled: row.window_enabled,
        windowPeriod: row.window_period,
        windowCount: row.window_count != null ? Number(row.window_count) : null,
        maxQtyPerWindow: row.max_qty_per_window != null ? Number(row.max_qty_per_window) : null,
        exemptOrderCapWithOtherItems: row.exempt_order_cap_with_other_items,
      })
    }
    return map
  }

  /**
   * Batch product -> category lookup, used to determine which cart lines
   * fall inside a CATEGORY-scoped rule's aggregate (the cart itself only
   * knows productId, not category).
   *
   * @param {string[]} productIds
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Map<string, string|null>>} productId -> categoryId
   */
  async getCategoryMap(productIds, client = null) {
    const ids = Array.from(new Set(productIds)).filter(Boolean)
    if (ids.length === 0) return new Map()

    const exec = this._exec(client)
    const { rows } = await exec(
      `SELECT id, category_id FROM products WHERE id = ANY($1::uuid[])`,
      [ids]
    )
    return new Map(rows.map((r) => [r.id, r.category_id]))
  }

  /**
   * How much of a rule's target (a product, or every product in a
   * category) has `userId` already bought in the last `windowDays` days.
   *
   * Rolling window (NOW() - N days), not a calendar reset — closes the
   * "buy at 11:59pm, buy again at 12:01am" loophole a calendar reset would
   * have, and needs no timezone handling since it's duration-based.
   *
   * Computed live from order_items — no separate usage ledger, so a
   * cancelled/refunded order frees up quota automatically with no cleanup
   * job. PENDING orders (payment not yet confirmed) intentionally DO
   * count: stock is already reserved for them, and excluding them would
   * let a customer bypass the cap with several simultaneous unpaid orders.
   *
   * @param {string} userId
   * @param {{targetType:string, productId?:string, categoryId?:string}} target
   * @param {number} windowDays
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async getWindowUsage(userId, target, windowDays, client = null) {
    const exec = this._exec(client)
    const { rows } = await exec(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS qty
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
        WHERE o.user_id = $1
          AND o.status NOT IN ('CANCELLED', 'REFUNDED')
          AND o.created_at >= NOW() - ($2 || ' days')::interval
          AND (
               ($3 = 'PRODUCT'  AND oi.product_id = $4::uuid)
            OR ($3 = 'CATEGORY' AND p.category_id = $5::uuid)
              )`,
      [
        userId,
        String(windowDays),
        target.targetType,
        target.targetType === 'PRODUCT' ? target.productId : null,
        target.targetType === 'CATEGORY' ? target.categoryId : null,
      ]
    )
    return Number(rows[0]?.qty || 0)
  }

  /** WEEK/DAY/MONTH + a count -> flat day count (30-day month, no calendar edge cases). */
  static windowDaysFor(period, count) {
    const perUnit = WINDOW_DAYS_PER_UNIT[period] || 1
    return perUnit * (Number(count) || 1)
  }

  _format(row) {
    return {
      id: row.id,
      scope: row.scope,
      shopId: row.shop_id,
      targetType: row.target_type,
      categoryId: row.category_id,
      categoryName: row.category_name ?? null,
      productId: row.product_id,
      productName: row.product_name ?? null,
      label: row.label,
      maxQtyPerOrder: row.max_qty_per_order != null ? Number(row.max_qty_per_order) : null,
      windowEnabled: row.window_enabled,
      windowPeriod: row.window_period,
      windowCount: row.window_count != null ? Number(row.window_count) : null,
      maxQtyPerWindow: row.max_qty_per_window != null ? Number(row.max_qty_per_window) : null,
      exemptOrderCapWithOtherItems: row.exempt_order_cap_with_other_items,
      isActive: row.is_active,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
