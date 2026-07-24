import { query } from '../../config/database.js'
import { ShopsRepository } from '../shops/shops.repository.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'

const PAGE_LIMIT = 1000

// Orders in any of these states still have a delivery outstanding — used to
// flag a covered customer as "has an active order" on the coverage map.
const ACTIVE_ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PREPARING', 'PACKED', 'OUT_FOR_DELIVERY']

export class CoverageMapRepository {
  constructor(deps = {}) {
    this.shopsRepo = deps.shopsRepository || new ShopsRepository()
    this.allocationRepo = deps.allocationRepository || new AllocationRepository()
  }

  async getShop(shopId) {
    return this.shopsRepo.findById(shopId)
  }

  /**
   * Every customer whose default address is currently serviceable by this
   * shop — the same live pincode/radius match that gates allocation (see
   * allocation.repository.js#findUsersAffectedByShop) rather than a
   * possibly-stale user_shop_allocations snapshot. Pages through in full;
   * that method caps each call at 1000 rows.
   */
  async getCoveredCustomers(shopId) {
    const points = []
    let afterUserId = null
    for (;;) {
      const page = await this.allocationRepo.findUsersAffectedByShop(shopId, {
        afterUserId,
        limit: PAGE_LIMIT,
      })
      if (page.length === 0) break
      points.push(...page)
      afterUserId = page[page.length - 1].user_id
      if (page.length < PAGE_LIMIT) break
    }

    const withCoords = points.filter((p) => p.lat !== null && p.lng !== null)
    if (withCoords.length === 0) return []

    const userIds = withCoords.map((p) => p.user_id)
    const { rows: users } = await query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [
      userIds,
    ])
    const nameById = new Map(users.map((u) => [u.id, u.name]))

    const { rows: activeOrderRows } = await query(
      `SELECT DISTINCT user_id FROM orders WHERE user_id = ANY($1::uuid[]) AND status = ANY($2::order_status[])`,
      [userIds, ACTIVE_ORDER_STATUSES]
    )
    const hasActiveOrder = new Set(activeOrderRows.map((r) => r.user_id))

    return withCoords.map((p) => ({
      userId: p.user_id,
      name: nameById.get(p.user_id) || null,
      lat: p.lat,
      lng: p.lng,
      pincode: p.pincode,
      hasActiveOrder: hasActiveOrder.has(p.user_id),
    }))
  }
}
