import { query } from '../../config/database.js'

/**
 * Shop Staff repository — all SQL queries for shop_staff
 * NEVER uses SELECT * — always named columns
 * All queries use parameterized placeholders ($1, $2...)
 */
export class ShopStaffRepository {
  /**
   * Create a new shop staff record.
   * Caller is responsible for limit checks and duplicate detection.
   * @param {object} data - { user_id, shop_id, role, permissions, invited_by }
   * @returns {Promise<object>} Created record
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO shop_staff (
        user_id, shop_id, role, permissions, invited_by
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, shop_id, role, permissions,
        is_active, invited_by, created_at, updated_at`,
      [
        data.user_id,
        data.shop_id,
        data.role,
        JSON.stringify(data.permissions || []),
        data.invited_by || null,
      ]
    )
    return rows[0]
  }

  /**
   * Find shop staff record by ID, scoped to shop_id.
   *
   * Requirement 15.3 — soft-deleted rows are excluded by default. Pass
   * `includeDeleted: true` to surface soft-deleted staff for admin
   * restoration / audit paths.
   *
   * Pass shopId=null to fetch without scope (e.g., super admin lookup).
   *
   * @param {string} id - Staff record UUID
   * @param {string|null} shopId - Optional shop scope filter
   * @param {object} [opts]
   * @param {boolean} [opts.includeDeleted=false]
   * @returns {Promise<object|null>}
   */
  async findById(id, shopId = null, { includeDeleted = false } = {}) {
    const deletedClause = includeDeleted ? '' : ' AND deleted_at IS NULL'
    if (shopId) {
      const { rows } = await query(
        `SELECT id, user_id, shop_id, role, permissions,
          is_active, invited_by, deleted_at, created_at, updated_at
        FROM shop_staff
        WHERE id = $1 AND shop_id = $2${deletedClause}`,
        [id, shopId]
      )
      return rows[0] || null
    }

    const { rows } = await query(
      `SELECT id, user_id, shop_id, role, permissions,
        is_active, invited_by, deleted_at, created_at, updated_at
      FROM shop_staff
      WHERE id = $1${deletedClause}`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Find an active shop staff record by user_id and shop_id (excludes soft-deleted).
   * Used for duplicate-assignment detection.
   * @param {string} userId
   * @param {string} shopId
   * @returns {Promise<object|null>}
   */
  async findByUserAndShop(userId, shopId) {
    const { rows } = await query(
      `SELECT id, user_id, shop_id, role, permissions,
        is_active, invited_by, deleted_at, created_at, updated_at
      FROM shop_staff
      WHERE user_id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
      [userId, shopId]
    )
    return rows[0] || null
  }

  /**
   * Count active staff for a shop (for max-50 limit enforcement).
   * Uses idx_shop_staff_shop_active.
   * @param {string} shopId
   * @returns {Promise<number>}
   */
  async countActiveByShop(shopId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
      FROM shop_staff
      WHERE shop_id = $1 AND deleted_at IS NULL AND is_active = true`,
      [shopId]
    )
    return rows[0].count
  }

  /**
   * Count active shop assignments for a user (for max-10 limit enforcement).
   * Uses idx_shop_staff_user_id.
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async countActiveByUser(userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
      FROM shop_staff
      WHERE user_id = $1 AND deleted_at IS NULL AND is_active = true`,
      [userId]
    )
    return rows[0].count
  }

  /**
   * List shop staff with filtering, pagination (scoped to shop_id).
   * Single LEFT JOIN to users to avoid N+1 lookups.
   *
   * Requirement 15.3 — soft-deleted rows are excluded by default. Pass
   * `include_deleted: 'true'` (matches the route schema) or
   * `includeDeleted: true` to surface soft-deleted staff for admin
   * restoration / audit views.
   *
   * @param {object} filters - { shopId, page, limit, role, is_active, include_deleted }
   * @returns {Promise<{staff: Array, total: number}>}
   */
  async findMany({
    shopId,
    page = 1,
    limit = 20,
    role,
    is_active,
    include_deleted,
    includeDeleted,
  }) {
    const offset = (page - 1) * limit
    const showDeleted =
      includeDeleted === true || include_deleted === 'true'
    const conditions = ['ss.shop_id = $1']
    const params = [shopId]
    let paramIdx = 2

    if (!showDeleted) {
      conditions.push('ss.deleted_at IS NULL')
    }

    if (role) {
      conditions.push(`ss.role = $${paramIdx++}`)
      params.push(role)
    }

    if (is_active === 'true') {
      conditions.push('ss.is_active = true')
    } else if (is_active === 'false') {
      conditions.push('ss.is_active = false')
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ss.id, ss.user_id, ss.shop_id, ss.role, ss.permissions,
          ss.is_active, ss.invited_by, ss.created_at, ss.updated_at,
          u.name AS user_name, u.email AS user_email, u.phone AS user_phone
        FROM shop_staff ss
        LEFT JOIN users u ON u.id = ss.user_id
        WHERE ${where}
        ORDER BY ss.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
        FROM shop_staff ss
        WHERE ${where}`,
        params
      ),
    ])

    return {
      staff: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Update shop staff record by ID, scoped to shop_id.
   * @param {string} id - Staff record UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @param {object} data - Fields to update (role, permissions, is_active)
   * @returns {Promise<object|null>}
   */
  async update(id, shopId, data) {
    const fields = []
    const params = []
    let idx = 1

    if (data.role !== undefined) {
      fields.push(`role = $${idx++}`)
      params.push(data.role)
    }

    if (data.permissions !== undefined) {
      fields.push(`permissions = $${idx++}`)
      params.push(JSON.stringify(data.permissions))
    }

    if (data.is_active !== undefined) {
      fields.push(`is_active = $${idx++}`)
      params.push(data.is_active)
    }

    if (fields.length === 0) return this.findById(id, shopId)

    fields.push('updated_at = NOW()')
    params.push(id, shopId)

    const { rows } = await query(
      `UPDATE shop_staff SET ${fields.join(', ')}
       WHERE id = $${idx} AND shop_id = $${idx + 1} AND deleted_at IS NULL
       RETURNING id, user_id, shop_id, role, permissions,
         is_active, invited_by, created_at, updated_at`,
      params
    )
    return rows[0] || null
  }

  /**
   * Soft-delete shop staff record by ID, scoped to shop_id.
   * Sets deleted_at=NOW() and is_active=false.
   * @param {string} id - Staff record UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @returns {Promise<boolean>}
   */
  async softDelete(id, shopId) {
    const { rowCount } = await query(
      `UPDATE shop_staff
       SET deleted_at = NOW(), is_active = false, updated_at = NOW()
       WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
      [id, shopId]
    )
    return rowCount > 0
  }

  /**
   * Find user_ids of all active staff in a shop matching any of the given
   * roles (Requirement 11.4, 11.9 — notify SHOP_ADMIN/SHOP_MANAGER on
   * stock-out and low stock).
   *
   * Uses idx_shop_staff_shop_active for the (shop_id, is_active=true) filter
   * and idx_shop_staff_shop_role for the role narrowing — no full table scan.
   *
   * @param {string} shopId
   * @param {string[]} roles - one or more of SHOP_ADMIN, SHOP_MANAGER, SHOP_STAFF, SHOP_VIEWER
   * @returns {Promise<string[]>} distinct user_ids
   */
  async findActiveUserIdsByShopAndRoles(shopId, roles) {
    if (!shopId || !Array.isArray(roles) || roles.length === 0) return []
    const { rows } = await query(
      `SELECT DISTINCT user_id
       FROM shop_staff
       WHERE shop_id = $1
         AND deleted_at IS NULL
         AND is_active = true
         AND role = ANY($2::text[])`,
      [shopId, roles]
    )
    return rows.map((r) => r.user_id)
  }
}
