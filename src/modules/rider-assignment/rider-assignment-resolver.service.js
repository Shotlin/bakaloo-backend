import { logger } from '../../config/logger.js'
import { query } from '../../config/database.js'
import { extractAddressId } from '../../utils/deliveryAddress.js'
import { haversineDistanceKm } from '../../utils/geo.js'
import { RiderAssignmentRepository } from './rider-assignment.repository.js'
import { FinalizeAssignmentRepository } from './finalize-assignment.repository.js'
import { FinalizeAssignmentService } from './finalize-assignment.service.js'

/**
 * The new modular rider-assignment resolver — replaces the old
 * proximity-only, fan-out-to-every-online-rider auto-assign worker
 * (workers/processors.js#handleAutoAssign, left in place but no longer
 * invoked from the order-status-transition path) with a deterministic,
 * single-target decision in strict priority order:
 *
 *   1. Manual admin assignment — always wins, never auto-overwritten.
 *   2. Exact area-segment match (same customer AND exact saved address).
 *   3. General auto-assignment — capacity + store-filtered pool, ranked
 *      by workload, then distance to the pickup store, then fairness.
 *
 * Every call ends in exactly one outcome: a finalized assignment (via
 * FinalizeAssignmentService, the sole writer) or a logged "no eligible
 * rider" decision that flags the order for HQ's manual-assignment queue.
 */
export class RiderAssignmentResolverService {
  constructor(fastify) {
    this.fastify = fastify
    this.repo = new RiderAssignmentRepository()
    this.finalizeRepo = new FinalizeAssignmentRepository()
    this.finalizeService = new FinalizeAssignmentService(fastify)
  }

  async resolveAndFinalize(orderId, { manualRiderId = null, actorAdminId = null, trigger = 'SYSTEM' } = {}) {
    const order = await this._loadOrder(orderId)
    if (!order) return { success: false, reason: 'ORDER_NOT_FOUND' }

    // Tier 1 — manual admin assignment always wins.
    if (manualRiderId) {
      return this.finalizeService.finalize(orderId, {
        riderId: manualRiderId,
        method: 'MANUAL',
        reason: `Manually assigned by admin (${trigger})`,
        triggeredBy: actorAdminId || 'SYSTEM',
      })
    }

    // A manual pick from earlier must never be silently overwritten by a
    // later automatic re-resolve (e.g. a retried status transition).
    if (order.assignment_method === 'MANUAL') {
      return { success: false, reason: 'MANUAL_ASSIGNMENT_PROTECTED' }
    }

    // Tier 2 — exact area-segment match: same customer AND exact saved address.
    const addressId = extractAddressId(order.delivery_address)
    if (addressId) {
      const segmentResult = await this._tryAreaSegment(orderId, order, addressId, trigger)
      if (segmentResult) return segmentResult

      // Tier 2.5 — sticky-address rider preference: this exact customer
      // has ordered to this exact saved address before, and an admin
      // picked a rider for it then (customer_address_rider_preferences,
      // updated on every manual (re)assign). Auto-assigns the same rider
      // again — no separate admin click needed — as long as they're
      // still capacity-eligible; falls through to general auto-assign
      // otherwise (at capacity, or no sticky preference at all).
      const stickyResult = await this._tryStickyAddressPreference(orderId, order, addressId, trigger)
      if (stickyResult) return stickyResult
    }

    // Tier 3 — general auto-assignment.
    return this._runGeneralAutoAssign(orderId, order, trigger)
  }

  async _tryAreaSegment(orderId, order, addressId, trigger) {
    const matches = await this.repo.findMatchingSegments(order.user_id, addressId)
    if (matches.length === 0) return null

    const chosen = matches[0]
    let reason = `Area segment match: "${chosen.name}" (${chosen.id})`
    if (matches.length > 1) {
      reason = `Area segment conflict (${matches.length} active matches) resolved by priority/created_at fallback: chose "${chosen.name}" (${chosen.id})`
      logger.warn(
        { orderId, matches: matches.map((m) => ({ id: m.id, name: m.name, priority: m.priority })) },
        'Area segment assignment conflict — resolved by priority/created_at fallback'
      )
    }

    const globalCapacity = await this.repo.getGlobalDefaultCapacity()
    const capacity = await this.repo.getRiderCapacityStatus(chosen.rider_id, globalCapacity)

    // Segment assignment respects capacity but ignores online status — a
    // deliberate admin choice, like manual, but shouldn't silently
    // overload one rider past the fleet-wide cap.
    if (!capacity || capacity.active_count < capacity.capacity) {
      return this.finalizeService.finalize(orderId, {
        riderId: chosen.rider_id,
        method: 'AREA_SEGMENT',
        areaSegmentId: chosen.id,
        reason,
        triggeredBy: 'SYSTEM',
      })
    }

    await this.repo.logDecision({
      orderId,
      riderId: chosen.rider_id,
      method: 'AREA_SEGMENT',
      reason: `${reason} — skipped, rider at capacity (${capacity.active_count}/${capacity.capacity}); falling back to general auto-assignment`,
      triggeredBy: 'SYSTEM',
    })
    return null
  }

  async _tryStickyAddressPreference(orderId, order, addressId, trigger) {
    const riderId = await this.repo.findStickyAddressPreference(order.user_id, addressId)
    if (!riderId) return null

    const globalCapacity = await this.repo.getGlobalDefaultCapacity()
    const capacity = await this.repo.getRiderCapacityStatus(riderId, globalCapacity)

    // Same "respects capacity, ignores online status" rule as area
    // segments — a returning-customer match is a weaker signal than an
    // explicit admin-configured zone, but still automatic, not a mere
    // suggestion the admin has to click through.
    if (!capacity || capacity.active_count < capacity.capacity) {
      return this.finalizeService.finalize(orderId, {
        riderId,
        method: 'AUTO',
        reason: `Sticky address preference: same rider used for this customer's saved address before (${trigger})`,
        triggeredBy: 'SYSTEM',
      })
    }

    await this.repo.logDecision({
      orderId,
      riderId,
      method: 'AUTO',
      reason: `Sticky address preference skipped — rider at capacity (${capacity.active_count}/${capacity.capacity}); falling back to general auto-assignment`,
      triggeredBy: 'SYSTEM',
    })
    return null
  }

  async _runGeneralAutoAssign(orderId, order, trigger) {
    if (!order.shop_id) {
      return this._markNoEligibleRider(orderId, 'NO_SHOP_ON_ORDER')
    }

    const globalCapacity = await this.repo.getGlobalDefaultCapacity()
    const candidates = await this.repo.getEligibleAutoCandidates(order.shop_id, globalCapacity)
    if (candidates.length === 0) {
      return this._markNoEligibleRider(orderId, 'NO_ELIGIBLE_RIDER')
    }

    const shop = await this._loadShopCoords(order.shop_id)
    const ranked = candidates
      .map((c) => ({
        ...c,
        distanceKm:
          shop && c.current_lat != null && c.current_lng != null
            ? haversineDistanceKm(shop.lat, shop.lng, Number(c.current_lat), Number(c.current_lng))
            : null,
      }))
      .sort((a, b) => {
        if (a.active_count !== b.active_count) return a.active_count - b.active_count
        const aDist = a.distanceKm ?? Infinity
        const bDist = b.distanceKm ?? Infinity
        if (aDist !== bDist) return aDist - bDist
        const aTime = a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : 0
        const bTime = b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : 0
        return aTime - bTime
      })

    const winner = ranked[0]
    return this.finalizeService.finalize(orderId, {
      riderId: winner.rider_id,
      method: 'AUTO',
      reason: `Auto-assigned (${trigger}): workload=${winner.active_count}, distanceKm=${winner.distanceKm != null ? winner.distanceKm.toFixed(2) : 'unknown'}, lastAssignedAt=${winner.last_assigned_at ?? 'never'}`,
      triggeredBy: 'SYSTEM',
    })
  }

  async _loadOrder(orderId) {
    const { rows } = await query(
      `SELECT id, user_id, shop_id, rider_id, status, assignment_method, delivery_address, delivery_fee
       FROM orders WHERE id = $1`,
      [orderId]
    )
    return rows[0] || null
  }

  async _loadShopCoords(shopId) {
    const { rows } = await query(`SELECT lat, lng FROM shops WHERE id = $1`, [shopId])
    if (!rows[0] || rows[0].lat == null || rows[0].lng == null) return null
    return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) }
  }

  async _markNoEligibleRider(orderId, reasonCode) {
    await this.repo.logDecision({ orderId, riderId: null, method: 'NONE', reason: reasonCode, triggeredBy: 'SYSTEM' })
    await this.finalizeRepo.setManualRequired(orderId)
    if (this.fastify?.emitAutoAssignmentFailed) {
      this.fastify.emitAutoAssignmentFailed({ order_id: orderId, reason: reasonCode })
    }
    return { success: false, reason: reasonCode }
  }
}
