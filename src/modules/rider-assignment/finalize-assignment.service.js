import { logger } from '../../config/logger.js'
import { sendPush } from '../../utils/pushNotification.js'
import { generatePickupToken, QR_TOKEN_VERSION } from '../../utils/qrToken.js'
import { ACTIVE_ORDER_STATUSES } from '../../constants/orderStatus.js'
import { FinalizeAssignmentRepository } from './finalize-assignment.repository.js'
import { RiderAssignmentRepository } from './rider-assignment.repository.js'
import { CommissionSettingsRepository } from '../commission-settings/commission-settings.repository.js'

const DEFAULT_RIDER_EARNING = 25
// Dispatch-to-pickup window — same-day grocery delivery, so 24h comfortably
// covers a full shift with margin; not admin-configurable (no stated
// requirement for that), just a fixed constant.
const PICKUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The single commit path for every assignment tier (manual / area segment
 * / auto) — replaces the previously duplicated INSERT/UPDATE pairs in
 * orders.repository.js#assignRider/bulkAssign and
 * workers/processors.js#handleAutoAssign's assignment-creation block.
 */
export class FinalizeAssignmentService {
  constructor(fastify) {
    this.fastify = fastify
    this.repo = new FinalizeAssignmentRepository()
    this.assignmentLogRepo = new RiderAssignmentRepository()
    this.commissionRepo = new CommissionSettingsRepository()
  }

  /**
   * @param {string} orderId
   * @param {{riderId: string, method: 'MANUAL'|'AREA_SEGMENT'|'AUTO', areaSegmentId?: string, reason?: string, triggeredBy?: string}} opts
   */
  async finalize(orderId, { riderId, method, areaSegmentId = null, reason, triggeredBy }) {
    const client = await this.repo.getClient()
    let previousRiderId = null
    let assignment = null

    try {
      await client.query('BEGIN')

      const order = await this.repo.lockOrder(client, orderId)
      if (!order) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'ORDER_NOT_FOUND' }
      }

      // A cancelled/delivered/refunded order can never gain a rider —
      // without this, a stale retry or an admin action on an order that
      // was cancelled after entering the assignment pipeline would still
      // assign it, handing the rider a pickup for an order that no longer
      // exists from the customer's side.
      if (!ACTIVE_ORDER_STATUSES.includes(order.status)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'ORDER_NOT_ACTIVE' }
      }

      // Manual always wins — never let a later auto/segment resolve
      // silently overwrite an admin's explicit pick, even on retry.
      if (method !== 'MANUAL' && order.assignment_method === 'MANUAL') {
        await client.query('ROLLBACK')
        return { success: false, reason: 'MANUAL_ASSIGNMENT_PROTECTED' }
      }

      if (order.rider_id === riderId) {
        // Re-resolved to the same rider — nothing to change, no need to
        // churn the assignment row or reissue a pickup token.
        await client.query('ROLLBACK')
        return { success: true, unchanged: true, riderId }
      }

      previousRiderId = order.rider_id
      await this.repo.cancelOpenAssignment(client, orderId, `Reassigned (${method})`)

      const commissionEnabled = await this.commissionRepo.isCommissionEnabled()
      const configuredFee = Number(order.delivery_fee)
      const earnings = commissionEnabled
        ? (Number.isFinite(configuredFee) && configuredFee > 0 ? configuredFee : DEFAULT_RIDER_EARNING)
        : 0

      assignment = await this.repo.insertAssignment(client, orderId, riderId, earnings)
      await this.repo.updateOrderAssignment(client, orderId, { riderId, method, areaSegmentId })
      await this.repo.revokeActiveTokens(client, orderId, `Reassigned (${method})`)

      const token = generatePickupToken()
      const expiresAt = new Date(Date.now() + PICKUP_TOKEN_TTL_MS)
      await this.repo.mintToken(client, {
        orderId, assignmentId: assignment.id, token, version: QR_TOKEN_VERSION, expiresAt,
      })

      await this.repo.updateLastAssignedAt(client, riderId)

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    await this.assignmentLogRepo.logDecision({ orderId, riderId, method, reason, triggeredBy })

    if (previousRiderId && previousRiderId !== riderId && this.fastify?.emitOrderExpiredToRider) {
      // Reused, not reinvented — same event the existing offer-fan-out flow
      // uses to tell a losing rider their copy of an order is gone. No
      // push here; the spec only requires notifying the newly assigned rider.
      this.fastify.emitOrderExpiredToRider(previousRiderId, { orderId, reason: 'REASSIGNED' })
    }

    await this._notifyNewRider(orderId, riderId, assignment.id)

    return { success: true, riderId, assignmentId: assignment.id, method }
  }

  async _notifyNewRider(orderId, riderId, assignmentId) {
    const shouldNotify = await this.repo.claimNotificationSlot(assignmentId)
    if (!shouldNotify) return

    if (this.fastify?.emitOrderAssignedToRider) {
      // 'ACCEPTED', matching what insertAssignment() actually wrote — the
      // rider app treats this as a signal to refetch its order list
      // rather than parsing a full order out of this deliberately minimal
      // payload, so the exact status string mainly matters for anyone
      // inspecting the raw socket event directly.
      this.fastify.emitOrderAssignedToRider(riderId, { orderId, status: 'ACCEPTED' })
    }

    try {
      const tokens = await this.repo.getRiderFcmTokens(riderId)
      if (tokens.length === 0) return
      await Promise.allSettled(
        tokens.map((fcmToken) =>
          sendPush(fcmToken, {
            title: 'New delivery assigned',
            body: 'A new order has been added to your pickup list.',
            data: { type: 'ORDER_ASSIGNED', orderId },
          })
        )
      )
    } catch (err) {
      logger.warn({ err: err.message, orderId, riderId }, 'Rider assignment push failed (non-blocking)')
    }
  }
}
