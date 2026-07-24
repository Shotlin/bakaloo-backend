import { query } from '../../config/database.js'

const COLUMNS = `
  id, name, min_order_amount, reward_type, reward_value, max_discount,
  unlock_coupon_id, start_at, end_at, is_active, auto_apply,
  payment_method_scope, cashback_credit_trigger,
  applicable_category_ids, applicable_product_ids, grants_free_delivery,
  created_by, created_at, updated_at
`

export class FirstTimeOffersRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM first_time_offers ORDER BY min_order_amount ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM first_time_offers WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Every currently-active, date-valid, payment-scope-compatible offer,
   * regardless of the cart's total — deliberately NOT filtered by
   * min_order_amount, unlike the old findBestFitActive(). A category/
   * product-scoped offer can only be evaluated against the matching slice
   * of the cart (see resolveMatchingProductIds), which the SQL layer has
   * no way to compute — so the service does that in JS per-candidate and
   * needs the full active set, both to pick the best currently-satisfied
   * offer AND to find the closest not-yet-satisfied one to tease.
   *
   * Ordered by min_order_amount ASC (cheapest-to-unlock first) — purely a
   * convenience for the service's tie-break scans, not load-bearing.
   */
  async findAllActiveCandidates({ onlinePayment } = {}) {
    const clauses = [
      'is_active = true',
      '(start_at IS NULL OR start_at <= NOW())',
      '(end_at IS NULL OR end_at >= NOW())',
    ]
    const params = []
    if (onlinePayment === false) {
      // COD checkout — exclude offers scoped to online payment only.
      clauses.push(`payment_method_scope != 'ONLINE_ONLY'`)
    }
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM first_time_offers
       WHERE ${clauses.join(' AND ')}
       ORDER BY min_order_amount ASC`,
      params
    )
    return rows.map((row) => this._format(row))
  }

  /**
   * True only once userId has an order that was actually DELIVERED — same
   * first-order check used by FIRST_TIME coupon targeting
   * (coupons.repository.js). Checks delivered_at rather than status, since
   * delivered_at is written exactly once (COALESCE-guarded) the moment an
   * order is marked DELIVERED and is never cleared afterward — so a later
   * REFUNDED transition still correctly counts as "has ordered before",
   * while a cancelled order, or one stuck PENDING after a failed payment,
   * correctly does NOT. A simple `status != 'CANCELLED'` check used to gate
   * this, which meant any non-cancelled order — including one abandoned
   * after a failed online payment that never formally transitions to
   * CANCELLED — silently and permanently killed the customer's first-order
   * offer even though nothing was ever delivered to them.
   */
  async hasPriorOrder(userId) {
    const { rows } = await query(
      `SELECT EXISTS(
         SELECT 1 FROM orders WHERE user_id = $1 AND delivered_at IS NOT NULL
       ) AS has_prior`,
      [userId]
    )
    return rows[0].has_prior
  }

  async create(data) {
    const { rows } = await query(
      `INSERT INTO first_time_offers (
         name, min_order_amount, reward_type, reward_value, max_discount,
         unlock_coupon_id, start_at, end_at, auto_apply,
         payment_method_scope, cashback_credit_trigger,
         applicable_category_ids, applicable_product_ids, grants_free_delivery,
         created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${COLUMNS}`,
      [
        data.name,
        data.minOrderAmount ?? 0,
        data.rewardType,
        data.rewardValue ?? null,
        data.maxDiscount ?? null,
        data.unlockCouponId ?? null,
        data.startAt ?? null,
        data.endAt ?? null,
        data.autoApply ?? true,
        data.paymentMethodScope ?? 'ALL',
        data.cashbackCreditTrigger ?? 'ORDER_DELIVERED',
        data.applicableCategoryIds?.length ? data.applicableCategoryIds : null,
        data.applicableProductIds?.length ? data.applicableProductIds : null,
        !!data.grantsFreeDelivery,
        data.createdBy ?? null,
      ]
    )
    return this._format(rows[0])
  }

  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      name: 'name',
      minOrderAmount: 'min_order_amount',
      rewardType: 'reward_type',
      rewardValue: 'reward_value',
      maxDiscount: 'max_discount',
      unlockCouponId: 'unlock_coupon_id',
      startAt: 'start_at',
      endAt: 'end_at',
      isActive: 'is_active',
      autoApply: 'auto_apply',
      paymentMethodScope: 'payment_method_scope',
      cashbackCreditTrigger: 'cashback_credit_trigger',
      applicableCategoryIds: 'applicable_category_ids',
      applicableProductIds: 'applicable_product_ids',
      grantsFreeDelivery: 'grants_free_delivery',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        const isArrayScopeField = jsKey === 'applicableCategoryIds' || jsKey === 'applicableProductIds'
        fields.push(`${dbKey} = $${idx++}`)
        params.push(isArrayScopeField && !data[jsKey]?.length ? null : data[jsKey])
      }
    }
    if (fields.length === 0) return this.findById(id)
    fields.push(`updated_at = NOW()`)
    params.push(id)
    const { rows } = await query(
      `UPDATE first_time_offers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async delete(id) {
    const result = await query(`DELETE FROM first_time_offers WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  /**
   * Of `cartProductIds`, which ones fall inside an offer's
   * applicable_category_ids/applicable_product_ids scope. Identical logic
   * to CouponsRepository#resolveMatchingProductIds — a category id can be
   * an ordinary/sub-category (products.category_id) or a BUNDLE (matched
   * via category_products). No scope at all means "matches everything",
   * the safe default that keeps existing unscoped offers unchanged.
   *
   * @param {string[]} cartProductIds
   * @param {{applicableCategoryIds?: string[]|null, applicableProductIds?: string[]|null}} scope
   * @returns {Promise<Set<string>>} matching product ids
   */
  async resolveMatchingProductIds(cartProductIds, { applicableCategoryIds, applicableProductIds } = {}) {
    const hasProductScope = Array.isArray(applicableProductIds) && applicableProductIds.length > 0
    const hasCategoryScope = Array.isArray(applicableCategoryIds) && applicableCategoryIds.length > 0

    if (!hasProductScope && !hasCategoryScope) {
      return new Set(cartProductIds)
    }
    if (cartProductIds.length === 0) {
      return new Set()
    }

    const { rows } = await query(
      `SELECT DISTINCT p.id AS product_id
         FROM products p
        WHERE p.id = ANY($1::uuid[])
          AND (
               ($2::uuid[] IS NOT NULL AND p.id = ANY($2::uuid[]))
            OR ($3::uuid[] IS NOT NULL AND (
                     p.category_id = ANY($3::uuid[])
                  OR EXISTS (
                       SELECT 1 FROM category_products cp
                       WHERE cp.product_id = p.id AND cp.category_id = ANY($3::uuid[])
                     )
                ))
              )`,
      [
        cartProductIds,
        hasProductScope ? applicableProductIds : null,
        hasCategoryScope ? applicableCategoryIds : null,
      ]
    )
    return new Set(rows.map((r) => r.product_id))
  }

  /**
   * Human-readable names for a set of category ids — lets the "add X to
   * unlock this offer" teaser name the actual category/bundle instead of a
   * generic "specific products". Identical to CouponsRepository's version.
   *
   * @param {string[]} categoryIds
   * @returns {Promise<string[]>}
   */
  async getCategoryNames(categoryIds) {
    if (!Array.isArray(categoryIds) || categoryIds.length === 0) return []
    const { rows } = await query(
      `SELECT name FROM categories WHERE id = ANY($1::uuid[]) ORDER BY name ASC`,
      [categoryIds]
    )
    return rows.map((r) => r.name)
  }

  /**
   * Human-readable names for a set of product ids — same purpose as
   * getCategoryNames(), for offers scoped to specific products.
   *
   * @param {string[]} productIds
   * @returns {Promise<string[]>}
   */
  async getProductNames(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) return []
    const { rows } = await query(
      `SELECT name FROM products WHERE id = ANY($1::uuid[]) ORDER BY name ASC`,
      [productIds]
    )
    return rows.map((r) => r.name)
  }

  _format(row) {
    return {
      id: row.id,
      name: row.name,
      minOrderAmount: parseFloat(row.min_order_amount),
      rewardType: row.reward_type,
      rewardValue: row.reward_value != null ? parseFloat(row.reward_value) : null,
      maxDiscount: row.max_discount != null ? parseFloat(row.max_discount) : null,
      unlockCouponId: row.unlock_coupon_id,
      startAt: row.start_at,
      endAt: row.end_at,
      isActive: row.is_active,
      autoApply: row.auto_apply,
      paymentMethodScope: row.payment_method_scope,
      cashbackCreditTrigger: row.cashback_credit_trigger,
      applicableCategoryIds: row.applicable_category_ids,
      applicableProductIds: row.applicable_product_ids,
      grantsFreeDelivery: row.grants_free_delivery,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
