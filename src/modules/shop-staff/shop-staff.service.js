import { logger } from '../../config/logger.js'
import { invalidateStaffActiveCache } from '../../middlewares/shop-scope.js'

const MAX_STAFF_PER_SHOP = 50
const MAX_SHOPS_PER_USER = 10

/**
 * Shop Staff service — business logic for shop staff management.
 * Enforces:
 *   - max 50 active staff per shop      (Requirement 2.5)
 *   - max 10 active shops per user      (Requirement 2.2)
 *   - unique active (user_id, shop_id)  (Requirement 2.3)
 */
export class ShopStaffService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Assign a user to a shop as staff.
   * @param {object} data - Validated data { shop_id, user_id, role, permissions }
   * @param {string} invitedBy - Inviter's user ID from JWT
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async create(data, invitedBy) {
    const { shop_id: shopId, user_id: userId, role, permissions } = data

    // Enforce unique active (user_id, shop_id) — Requirement 2.3
    const existing = await this.repo.findByUserAndShop(userId, shopId)
    if (existing) {
      return {
        success: false,
        message: 'User is already assigned to this shop',
        code: 'STAFF_ALREADY_ASSIGNED',
      }
    }

    // Enforce max 50 active staff per shop — Requirement 2.5
    const shopStaffCount = await this.repo.countActiveByShop(shopId)
    if (shopStaffCount >= MAX_STAFF_PER_SHOP) {
      return {
        success: false,
        message: `Maximum ${MAX_STAFF_PER_SHOP} staff members per shop reached`,
        code: 'STAFF_LIMIT_REACHED',
      }
    }

    // Enforce max 10 active shops per user — Requirement 2.2
    const userShopCount = await this.repo.countActiveByUser(userId)
    if (userShopCount >= MAX_SHOPS_PER_USER) {
      return {
        success: false,
        message: `User cannot be assigned to more than ${MAX_SHOPS_PER_USER} shops`,
        code: 'STAFF_SHOP_LIMIT',
      }
    }

    const record = await this.repo.create({
      user_id: userId,
      shop_id: shopId,
      role,
      permissions: permissions || [],
      invited_by: invitedBy,
    })

    logger.info(
      {
        userId: invitedBy,
        shopId,
        action: 'shop_staff_assigned',
        targetUserId: userId,
        role,
      },
      'Shop staff assigned'
    )

    return { success: true, data: record }
  }

  /**
   * List staff for a shop (paginated, filterable).
   * @param {string} shopId - Shop UUID
   * @param {object} filters - { page, limit, role, is_active }
   * @returns {Promise<{staff, total, page, limit}>}
   */
  async list(shopId, filters) {
    const { staff, total } = await this.repo.findMany({
      shopId,
      ...filters,
    })

    return {
      staff,
      total,
      page: filters.page,
      limit: filters.limit,
    }
  }

  /**
   * Get a single staff record (scoped to shop_id).
   * @param {string} id - Staff record UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @returns {Promise<object|null>}
   */
  async getById(id, shopId) {
    return this.repo.findById(id, shopId)
  }

  /**
   * Update a staff record (role, permissions, is_active).
   * @param {string} id - Staff record UUID
   * @param {object} data - Fields to update
   * @param {string} shopId - Shop UUID for scope enforcement
   * @param {string} userId - Requester's user ID
   * @returns {Promise<{success, data?, message?, code?}>}
   */
  async update(id, data, shopId, userId) {
    const updated = await this.repo.update(id, shopId, data)
    if (!updated) {
      return {
        success: false,
        message: 'Staff record not found',
        code: 'STAFF_NOT_FOUND',
      }
    }

    // Requirement 2.11 — invalidate the staff-active cache so that any token
    // referencing this assignment is rejected within 5 minutes (cache TTL).
    // We do this for any update because the active state is derived from
    // shop_staff.is_active AND shop_staff.deleted_at AND shop.is_active —
    // any of those can change here.
    await invalidateStaffActiveCache(updated.user_id, updated.shop_id)

    logger.info(
      {
        userId,
        shopId,
        action: 'shop_staff_updated',
        staffId: id,
        targetUserId: updated.user_id,
      },
      'Shop staff updated'
    )

    return { success: true, data: updated }
  }

  /**
   * Soft-delete (deactivate) a staff record.
   * @param {string} id - Staff record UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @param {string} userId - Requester's user ID
   * @returns {Promise<{success, message?, code?}>}
   */
  async delete(id, shopId, userId) {
    // Resolve the staff record first so we have user_id for cache invalidation
    // (softDelete doesn't return rows). Both queries hit the same indexed
    // (id, shop_id, deleted_at) lookup, so the extra round-trip is cheap.
    const existing = await this.repo.findById(id, shopId)
    if (!existing) {
      return {
        success: false,
        message: 'Staff record not found',
        code: 'STAFF_NOT_FOUND',
      }
    }

    const deleted = await this.repo.softDelete(id, shopId)
    if (!deleted) {
      return {
        success: false,
        message: 'Staff record not found',
        code: 'STAFF_NOT_FOUND',
      }
    }

    // Requirement 2.11 — invalidate cache so token referencing this
    // assignment is rejected within 5 minutes by shop-scope middleware.
    await invalidateStaffActiveCache(existing.user_id, existing.shop_id)

    logger.info(
      {
        userId,
        shopId,
        action: 'shop_staff_deactivated',
        staffId: id,
        targetUserId: existing.user_id,
      },
      'Shop staff deactivated'
    )

    return { success: true }
  }
}
