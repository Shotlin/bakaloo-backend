import crypto from 'node:crypto'
import { logger } from '../../config/logger.js'
import { orderQueue } from '../../config/bullmq.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { buildCustomerOrderEventNotification } from '../notifications/customer-order-event.helper.js'
import { UploadsService } from '../uploads/uploads.service.js'

const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Delivery service — business logic for delivery operations
 */
export class DeliveryService {
  constructor(repository, fastify) {
    this.repository = repository
    this.fastify = fastify
    this.uploadsService = new UploadsService()
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
  }

  // ─── RIDER PROFILE ──────────────────────────────────

  async getRiderProfile(riderId) {
    const profile = await this.repository.getRiderProfile(riderId)
    if (!profile) throw new Error('Rider profile not found')
    return profile
  }

  async toggleOnline(riderId, isOnline) {
    const profile = await this.repository.getRiderProfile(riderId)
    if (!profile) {
      const err = new Error('Rider profile not found')
      err.statusCode = 404
      err.code = 'RIDER_NOT_FOUND'
      throw err
    }
    // Return a proper 403 instead of a plain Error (which became HTTP 500).
    // The Flutter app maps any non-success on toggle-online to RiderNotApprovedError.
    if (!profile.is_approved) {
      const err = new Error('Rider profile is not yet approved')
      err.statusCode = 403
      err.code = 'RIDER_NOT_APPROVED'
      throw err
    }

    const updatedProfile = await this.repository.toggleOnline(riderId, isOnline)

    if (isOnline) {
      await this._queueBacklogAssignScan('RIDER_WENT_ONLINE')
    }

    return updatedProfile
  }

  // ─── DOCUMENTS ────────────────────────────────────────

  async getDocuments(riderId) {
    const docs = await this.repository.getDocuments(riderId)
    return { documents: docs }
  }

  async uploadDocument({ riderId, fileStream, docType }) {
    // 1. Upload to Cloudinary
    const result = await this.uploadsService.uploadImage(fileStream, {
      folder: `grocery-app/riders/${riderId}/documents`,
    })

    // 2. Save to DB
    const doc = await this.repository.saveDocument(riderId, docType, result.url)
    return doc
  }

  // ─── ORDER FLOW ─────────────────────────────────────

  async getAssignedOrders(riderId, status) {
    const [orders, fallbackStore] = await Promise.all([
      this.repository.getAssignedOrders(riderId, status),
      this.repository.getStoreSettings(),
    ])

    const shopIds = [...new Set(orders.map((order) => order.shop_id).filter(Boolean))]
    const shopInfos = await Promise.all(
      shopIds.map((shopId) => this.repository.getShopInfo(shopId))
    )
    const storeByShopId = new Map(
      shopIds.map((shopId, index) => {
        const info = shopInfos[index]
        return [
          shopId,
          info && {
            name: info.name,
            address: info.address,
            phone: info.phone,
            lat: info.pickup_lat,
            lng: info.pickup_lng,
          },
        ]
      })
    )

    return orders.map((order) =>
      this._normalizeAssignedOrder(order, storeByShopId.get(order.shop_id) || fallbackStore)
    )
  }

  async acceptOrder(riderId, orderId) {
    const assignment = await this.repository.getAssignmentByOrderAndRider(orderId, riderId)
    if (!assignment) {
      const snapshot = await this.repository.getOrderAssignmentSnapshot(orderId, riderId)
      if (!snapshot) {
        throw {
          statusCode: 409,
          message: 'Order is no longer available',
          code: 'ORDER_NOT_AVAILABLE',
        }
      }
      if (!snapshot.order_status || !['CONFIRMED', 'PREPARING', 'PACKED'].includes(snapshot.order_status)) {
        throw {
          statusCode: 409,
          message: 'Order can no longer be accepted',
          code: 'ORDER_NOT_ASSIGNABLE',
        }
      }
      if (snapshot.rider_id && snapshot.rider_id !== riderId) {
        throw {
          statusCode: 409,
          message: 'Order already accepted by another rider',
          code: 'ORDER_ALREADY_CLAIMED',
        }
      }
      throw {
        statusCode: 409,
        message: 'Order is no longer available',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }

    const assignmentId = this._resolveAssignmentId(assignment)
    this._logDeliveryAction('accept:lookup', {
      orderId,
      riderId,
      assignmentId,
      assignmentStatus: assignment.status,
    })

    if (assignment.status !== 'ASSIGNED') {
      this._logDeliveryAction('accept:conflict', {
        orderId,
        riderId,
        assignmentId,
        assignmentStatus: assignment.status,
        reason: 'ORDER_NOT_AVAILABLE',
      })
      throw {
        statusCode: 409,
        message: 'Order is no longer available',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }

    const result = await this.repository.acceptOrder(assignmentId, orderId, riderId)
    if (result?.conflict) {
      this._logDeliveryAction('accept:conflict', {
        orderId,
        riderId,
        assignmentId,
        assignmentStatus: assignment.status,
        reason: result.reason,
      })
      if (result.reason === 'ORDER_ALREADY_CLAIMED') {
        throw {
          statusCode: 409,
          message: 'Order already accepted by another rider',
          code: 'ORDER_ALREADY_CLAIMED',
        }
      }
      throw {
        statusCode: 409,
        message: result.reason === 'ORDER_NOT_AVAILABLE'
          ? 'Order is no longer available'
          : 'Order can no longer be accepted',
        code: result.reason || 'ORDER_NOT_ASSIGNABLE',
      }
    }

    this._logDeliveryAction('accept:success', {
      orderId,
      riderId,
      assignmentId,
      assignmentStatus: 'ACCEPTED',
    })

    // Generate delivery OTP for customer verification
    const otp = crypto.randomInt(1000, 9999).toString()
    await this.repository.storeDeliveryOtp(orderId, otp)

    // Emit real-time update
    this._emitOrderUpdate(orderId, {
      status: 'ACCEPTED',
      orderStatus: assignment.order_status,
      timelineType: 'RIDER_ACCEPTED',
      riderId,
      message: 'Delivery partner accepted your order',
    }, [assignment.customer_id, riderId])

    // Queue notification to customer
    await this._queueNotification(
      assignment.customer_id,
      buildCustomerOrderEventNotification({
        orderId,
        orderNumber: assignment.order_number,
        timelineType: 'RIDER_ACCEPTED',
        status: assignment.order_status,
      })
    )

    for (const cancelledOffer of result.cancelledOffers || []) {
      const losingRiderId = cancelledOffer?.rider_id
      if (!losingRiderId) continue
      this._emitOrderExpired(orderId, losingRiderId, {
        orderId,
        assignmentId: cancelledOffer.id,
        status: 'EXPIRED',
        message: 'Accepted by another rider',
      })
    }

    return { ...result.assignment, deliveryOtp: otp }
  }

  async rejectOrder(riderId, orderId, reason) {
    const declineReason = `${reason || 'OTHER'}`.trim() || 'OTHER'
    const assignment = await this.repository.getAssignmentByOrderAndRider(orderId, riderId)
    if (!assignment) {
      const snapshot = await this.repository.getOrderAssignmentSnapshot(orderId, riderId)
      if (snapshot?.rider_id && snapshot.rider_id !== riderId) {
        throw {
          statusCode: 409,
          message: 'Order already accepted by another rider',
          code: 'ORDER_ALREADY_CLAIMED',
        }
      }
      throw {
        statusCode: 409,
        message: 'Order is no longer available',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }

    const assignmentId = this._resolveAssignmentId(assignment)
    this._logDeliveryAction('reject:lookup', {
      orderId,
      riderId,
      assignmentId,
      assignmentStatus: assignment.status,
      reason: declineReason,
    })

    if (assignment.status !== 'ASSIGNED') {
      this._logDeliveryAction('reject:conflict', {
        orderId,
        riderId,
        assignmentId,
        assignmentStatus: assignment.status,
        reason: 'ORDER_NOT_AVAILABLE',
      })
      throw {
        statusCode: 409,
        message: 'Order is no longer available',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }

    const result = await this.repository.rejectOrder(
      assignmentId,
      orderId,
      declineReason
    )
    if (!result?.assignment) {
      this._logDeliveryAction('reject:conflict', {
        orderId,
        riderId,
        assignmentId,
        assignmentStatus: assignment.status,
        reason: 'ORDER_NOT_AVAILABLE',
      })
      throw {
        statusCode: 409,
        message: 'Order is no longer available',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }

    this._emitOrderExpired(orderId, riderId, {
      orderId,
      orderNumber: assignment.order_number,
      reason: declineReason,
      message: 'Order declined and moved back to queue',
    })

    if (result.shouldReassign) {
      await this._queueAutoAssign(orderId, 'RIDER_REJECT_REQUEUE')
    }

    this._logDeliveryAction('reject:success', {
      orderId,
      riderId,
      assignmentId,
      assignmentStatus: 'CANCELLED',
      reason: declineReason,
    })

    return result.assignment
  }

  /**
   * Cancels a delivery the rider has already accepted/picked up —
   * the customer refuses the order at the door, doesn't answer calls,
   * or can't be reached. Terminal: the order is cancelled outright,
   * not requeued for another rider (unlike the pre-accept [rejectOrder]).
   */
  async cancelDelivery(riderId, orderId, reason) {
    const cancelReason = `${reason || 'OTHER'}`.trim() || 'OTHER'
    const assignment = await this.repository.getAssignmentByOrderAndRider(orderId, riderId)
    if (!assignment || !['ACCEPTED', 'IN_TRANSIT'].includes(assignment.status)) {
      throw {
        statusCode: 409,
        message: 'Order is no longer active',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }

    const assignmentId = this._resolveAssignmentId(assignment)
    this._logDeliveryAction('cancel:lookup', {
      orderId,
      riderId,
      assignmentId,
      assignmentStatus: assignment.status,
      reason: cancelReason,
    })

    const result = await this.repository.cancelDelivery(assignmentId, orderId, riderId, cancelReason)
    if (!result) {
      throw {
        statusCode: 409,
        message: 'Order is no longer active',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }

    this._emitOrderUpdate(orderId, {
      status: 'CANCELLED',
      orderStatus: 'CANCELLED',
      timelineType: 'CANCELLED',
      riderId,
      message: 'Your delivery was cancelled by the rider',
    }, [assignment.customer_id, riderId])

    await this._queueNotification(
      assignment.customer_id,
      buildCustomerOrderEventNotification({
        orderId,
        orderNumber: assignment.order_number,
        timelineType: 'CANCELLED',
        status: 'CANCELLED',
      })
    )

    this._logDeliveryAction('cancel:success', {
      orderId,
      riderId,
      assignmentId,
      assignmentStatus: 'CANCELLED',
      reason: cancelReason,
    })

    return result
  }

  async markPickedUp(riderId, orderId) {
    const assignment = await this.repository.getAssignmentByOrderAndRider(orderId, riderId)
    if (!assignment) {
      const snapshot = await this.repository.getOrderAssignmentSnapshot(orderId, riderId)
      if (snapshot?.assignment_status === 'IN_TRANSIT' || snapshot?.order_status === 'OUT_FOR_DELIVERY') {
        this._logDeliveryAction('pickup:idempotent-success', {
          orderId,
          riderId,
          assignmentId: snapshot.assignment_id ?? null,
          assignmentStatus: snapshot.assignment_status ?? 'IN_TRANSIT',
        })
        return {
          id: snapshot.assignment_id ?? null,
          status: 'IN_TRANSIT',
          alreadyPickedUp: true,
        }
      }

      throw {
        statusCode: 409,
        message: 'Order is no longer active',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }
    if (assignment.status === 'IN_TRANSIT') {
      this._logDeliveryAction('pickup:idempotent-success', {
        orderId,
        riderId,
        assignmentId: this._resolveAssignmentId(assignment),
        assignmentStatus: assignment.status,
      })
      return assignment
    }
    if (assignment.status !== 'ACCEPTED') {
      throw {
        statusCode: 409,
        message: 'Order must be accepted first',
        code: 'ORDER_NOT_ACCEPTED',
      }
    }

    const assignmentId = this._resolveAssignmentId(assignment)
    this._logDeliveryAction('pickup:lookup', {
      orderId,
      riderId,
      assignmentId,
      assignmentStatus: assignment.status,
    })

    const result = await this.repository.markPickedUp(assignmentId, orderId)
    if (!result) {
      throw {
        statusCode: 409,
        message: 'Order is no longer active',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }

    this._emitOrderUpdate(orderId, {
      status: 'IN_TRANSIT',
      orderStatus: 'OUT_FOR_DELIVERY',
      timelineType: 'PICKED_UP',
      riderId,
      message: 'Your order is on its way!',
    }, [assignment.customer_id, riderId])

    // Task 12.6: Emit Socket.IO events for OUT_FOR_DELIVERY transition
    this._emitOutForDeliveryEvents(orderId, riderId, assignment)

    await this._queueNotification(
      assignment.customer_id,
      buildCustomerOrderEventNotification({
        orderId,
        orderNumber: assignment.order_number,
        timelineType: 'PICKED_UP',
        status: 'OUT_FOR_DELIVERY',
        otp: assignment.delivery_otp,
      })
    )

    return result
  }

  /**
   * Regenerates the delivery OTP and re-notifies the customer with the
   * new code. Used when the rider is in front of the customer but the
   * original OTP was lost, mistyped too many times, or the customer
   * didn't see the earlier notification.
   */
  async resendOtp(riderId, orderId) {
    const assignment = await this.repository.getAssignmentByOrderAndRider(orderId, riderId)
    if (!assignment || !['ACCEPTED', 'IN_TRANSIT'].includes(assignment.status)) {
      throw {
        statusCode: 409,
        message: 'Order must be accepted before resending the OTP',
        code: 'ORDER_NOT_ACTIVE',
      }
    }

    const otp = crypto.randomInt(1000, 9999).toString()
    await this.repository.storeDeliveryOtp(orderId, otp)

    this._logDeliveryAction('otp:resend', {
      orderId,
      riderId,
      assignmentId: this._resolveAssignmentId(assignment),
      assignmentStatus: assignment.status,
    })

    await this._queueNotification(
      assignment.customer_id,
      buildCustomerOrderEventNotification({
        orderId,
        orderNumber: assignment.order_number,
        timelineType: 'OTP_RESENT',
        status: assignment.order_status,
        otp,
      })
    )

    return { deliveryOtp: otp }
  }

  async markDelivered(riderId, orderId, otp, proofPhotoUrl, demoMode = false) {
    const assignment = await this.repository.getAssignmentByOrderAndRider(orderId, riderId)
    if (!assignment) {
      const snapshot = await this.repository.getOrderAssignmentSnapshot(orderId, riderId)
      if (snapshot?.assignment_status === 'DELIVERED' || snapshot?.order_status === 'DELIVERED') {
        const completionSummary = await this.repository.getDeliveryCompletionSummary(orderId, riderId)
        this._logDeliveryAction('deliver:idempotent-success', {
          orderId,
          riderId,
          assignmentId: snapshot.assignment_id ?? null,
          assignmentStatus: snapshot.assignment_status ?? 'DELIVERED',
          reason: 'ALREADY_DELIVERED',
        })
        return {
          id: snapshot.assignment_id ?? null,
          status: 'DELIVERED',
          alreadyDelivered: true,
          completionSummary,
        }
      }
      if (snapshot?.assignment_status === 'ACCEPTED' || snapshot?.order_status === 'OUT_FOR_DELIVERY') {
        throw {
          statusCode: 409,
          message: 'Order must be picked up before delivery',
          code: 'ORDER_NOT_IN_TRANSIT',
        }
      }
      throw {
        statusCode: 409,
        message: 'Order is no longer active',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }
    if (assignment.status === 'DELIVERED') {
      const completionSummary = await this.repository.getDeliveryCompletionSummary(orderId, riderId)
      this._logDeliveryAction('deliver:idempotent-success', {
        orderId,
        riderId,
        assignmentId: this._resolveAssignmentId(assignment),
        assignmentStatus: assignment.status,
        reason: 'ALREADY_DELIVERED',
      })
      return {
        ...assignment,
        completionSummary,
      }
    }
    if (assignment.status !== 'IN_TRANSIT') {
      throw {
        statusCode: 409,
        message: 'Order must be picked up before delivery',
        code: 'ORDER_NOT_IN_TRANSIT',
      }
    }

    const cleanOtp = `${otp || ''}`.trim()
    const cleanProof = `${proofPhotoUrl || ''}`.trim()
    const allowDemoDelivery =
      Boolean(demoMode) &&
      (process.env.NODE_ENV !== 'production' ||
        process.env.ALLOW_DEMO_DELIVERY_ACTIONS === 'true')

    if (!allowDemoDelivery && !cleanOtp && !cleanProof) {
      throw {
        statusCode: 400,
        message: 'OTP or delivery proof is required',
        code: 'OTP_OR_PROOF_REQUIRED',
      }
    }

    if (cleanOtp) {
      const valid = await this.repository.verifyDeliveryOtp(orderId, cleanOtp)
      if (!valid) {
        throw {
          statusCode: 400,
          message: 'OTP did not match. Ask the customer to read it again',
          code: 'INVALID_OTP',
        }
      }
    }

    const assignmentId = this._resolveAssignmentId(assignment)
    this._logDeliveryAction('deliver:lookup', {
      orderId,
      riderId,
      assignmentId,
      assignmentStatus: assignment.status,
      reason: allowDemoDelivery ? 'DEMO_MODE' : null,
    })

    const result = await this.repository.markDelivered(
      assignmentId, orderId, cleanProof || null
    )
    if (!result) {
      const snapshot = await this.repository.getOrderAssignmentSnapshot(orderId, riderId)
      if (snapshot?.assignment_status === 'DELIVERED' || snapshot?.order_status === 'DELIVERED') {
        const completionSummary = await this.repository.getDeliveryCompletionSummary(orderId, riderId)
        this._logDeliveryAction('deliver:idempotent-success', {
          orderId,
          riderId,
          assignmentId: snapshot.assignment_id ?? assignmentId,
          assignmentStatus: snapshot.assignment_status ?? 'DELIVERED',
          reason: 'ALREADY_DELIVERED',
        })
        return {
          id: snapshot.assignment_id ?? assignmentId,
          status: 'DELIVERED',
          alreadyDelivered: true,
          completionSummary,
        }
      }
      throw {
        statusCode: 409,
        message: 'Order is no longer active',
        code: 'ORDER_NOT_AVAILABLE',
      }
    }

    this._emitOrderUpdate(orderId, {
      status: 'DELIVERED',
      orderStatus: 'DELIVERED',
      timelineType: 'DELIVERED',
      riderId,
      message: 'Your order has been delivered!',
    }, [assignment.customer_id, riderId])

    await this._queueNotification(
      assignment.customer_id,
      buildCustomerOrderEventNotification({
        orderId,
        orderNumber: assignment.order_number,
        timelineType: 'DELIVERED',
        status: 'DELIVERED',
      })
    )

    return {
      ...result,
      completionSummary: result.completionSummary
        ?? await this.repository.getDeliveryCompletionSummary(orderId, riderId),
    }
  }

  async uploadDeliveryProof({ riderId, orderId, fileStream }) {
    const assignment = await this.repository.getAssignmentByOrderAndRider(orderId, riderId)
    if (!assignment) throw new Error('No active assignment for this order')

    const result = await this.uploadsService.uploadImage(fileStream, {
      folder: `grocery-app/riders/${riderId}/delivery-proof`,
    })

    await this.repository.saveProofPhoto(orderId, riderId, result.url)
    return { proofUrl: result.url }
  }

  async saveProofUrl({ riderId, orderId, proofPhotoUrl }) {
    const assignment = await this.repository.getAssignmentByOrderAndRider(orderId, riderId)
    if (!assignment) throw new Error('No active assignment for this order')

    await this.repository.saveProofPhoto(orderId, riderId, proofPhotoUrl)
    return { proofUrl: proofPhotoUrl }
  }

  // ─── STATS & LOCATION ──────────────────────────────

  async getDeliveryStats(riderId) {
    return await this.repository.getDeliveryStats(riderId)
  }

  async getDeliveryEarnings(riderId, period = 'month') {
    return await this.repository.getDeliveryEarnings(riderId, period)
  }

  async getDeliveryPayouts(riderId, page = 1, limit = 20) {
    return await this.repository.getDeliveryPayouts(riderId, { page, limit })
  }

  async getStoreInfo(shopId) {
    const shop = await this.repository.getShopInfo(shopId)
    return {
      name: shop?.name || 'Bakaloo Store',
      address: shop?.address || '',
      phone: shop?.phone || '',
      lat: Number(shop?.pickup_lat) || 0,
      lng: Number(shop?.pickup_lng) || 0,
    }
  }

  async updateLocation(riderId, latitude, longitude) {
    await this.repository.updateLocation(riderId, latitude, longitude)

    // Broadcast to admin dashboard and customers tracking this rider.
    // Sent to both the `order:<id>` room (joined via order:track,
    // which doesn't survive a socket reconnect unless the client
    // explicitly rejoins) AND directly to the customer's own
    // `user:<id>` room (joined automatically on every connect) so a
    // dropped room join can't silently stop location updates.
    if (this.fastify?.emitOrderUpdate) {
      const orders = await this.repository.getAssignedOrders(riderId, 'IN_TRANSIT')
      for (const order of orders) {
        this.fastify.emitOrderUpdate(order.order_id, [order.customer_id], {
          type: 'RIDER_LOCATION',
          lat: latitude,
          lng: longitude,
          riderId,
        })
      }
    }
  }

  async getDeliveryHistory(riderId, page = 1, limit = 20) {
    const offset = (page - 1) * limit
    return await this.repository.getDeliveryHistory(riderId, { limit, offset })
  }

  // ─── INTERNAL HELPERS ───────────────────────────────

  _emitOrderUpdate(orderId, data, userIds = []) {
    try {
      if (this.fastify?.emitOrderUpdate) {
        this.fastify.emitOrderUpdate(orderId, userIds, {
          orderId,
          timestamp: new Date().toISOString(),
          ...data,
        })
      }
    } catch (err) {
      logger.error({ err, orderId }, 'Failed to emit order update')
    }
  }

  _emitOrderExpired(orderId, riderId, data) {
    try {
      if (this.fastify?.emitOrderExpiredToRider) {
        this.fastify.emitOrderExpiredToRider(riderId, data)
      }
    } catch (err) {
      logger.error({ err, orderId, riderId }, 'Failed to emit order expiry')
    }
  }

  /**
   * Task 12.6: Emit Socket.IO events on OUT_FOR_DELIVERY transition
   * (a) customer channel — rider name, phone, live coords
   * (b) shop dashboard channel scoped to shop_id
   * (c) rider channel
   * HQ_Users in HQ_MODE receive on global delivery channel
   */
  _emitOutForDeliveryEvents(orderId, riderId, assignment) {
    try {
      if (this.fastify?.emitOutForDelivery) {
        this.fastify.emitOutForDelivery({
          orderId,
          shopId: assignment.shop_id || null,
          customerId: assignment.customer_id || null,
          riderId,
          riderName: assignment.rider_name || null,
          riderPhone: assignment.rider_phone || null,
          orderNumber: assignment.order_number || null,
        })
      }
    } catch (err) {
      logger.error({ err, orderId, riderId }, 'Failed to emit OUT_FOR_DELIVERY events')
    }
  }

  async _queueNotification(userId, notif) {
    if (!this.notificationsService || !userId || !notif) {
      return
    }

    try {
      await this.notificationsService.sendNotification(userId, notif)
    } catch (err) {
      logger.error(
        {
          err,
          userId,
          orderId: notif?.data?.orderId ?? null,
          timelineType: notif?.data?.timelineType ?? null,
        },
        'Failed to send customer notification'
      )
    }
  }

  async _queueAutoAssign(orderId, source) {
    try {
      await orderQueue.add(
        'auto-assign',
        { type: 'auto-assign', orderId, source },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      logger.warn({ err, orderId, source }, 'Failed to queue auto-assign job')
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
      logger.info({ orderId, source }, 'Inline auto-assign fallback executed')
    } catch (fallbackErr) {
      logger.error(
        { err: fallbackErr, orderId, source },
        'Inline auto-assign fallback failed'
      )
    }
  }

  async _queueBacklogAssignScan(source) {
    try {
      await orderQueue.add(
        'auto-assign-backlog',
        {
          type: 'auto-assign-backlog',
          source,
          limit: 500,
        },
        {
          jobId: 'auto-assign-backlog-on-rider-online',
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    } catch (err) {
      logger.warn({ err, source }, 'Failed to queue auto-assign backlog job')
    }
  }

  _resolveAssignmentId(assignment) {
    const assignmentId = assignment?.assignment_id ?? assignment?.id ?? null
    if (!assignmentId) {
      throw new Error('Assignment identifier missing')
    }
    return assignmentId
  }

  _logDeliveryAction(action, details = {}) {
    logger.info(
      {
        action,
        orderId: details.orderId ?? null,
        riderId: details.riderId ?? null,
        assignmentId: details.assignmentId ?? null,
        assignmentStatus: details.assignmentStatus ?? null,
        reason: details.reason ?? null,
      },
      'Delivery lifecycle action'
    )
  }

  _normalizeAssignedOrder(row, store) {
    const order = { ...row }
    const customerAddressRaw = this._parseAddress(order.delivery_address)
    const customerLat = this._toNullableNumber(
      customerAddressRaw.lat ?? customerAddressRaw.latitude
    )
    const customerLng = this._toNullableNumber(
      customerAddressRaw.lng ?? customerAddressRaw.longitude
    )
    const estimatedDistance = this._toNullableNumber(
      order.estimated_distance_km ??
      order.distance_km ??
      order.estimated_distance ??
      order.estimatedDistance
    )

    const offerTimeoutSeconds = 0
    const offerExpiresAt = null
    const isOfferActive = order.assignment_status !== 'CANCELLED'

    const estimatedDuration = estimatedDistance != null && estimatedDistance > 0
      ? Math.max(3, Math.round((estimatedDistance / 20) * 60))
      : 0

    return {
      ...order,
      id: order.order_id,
      orderId: order.order_id,
      assignmentId: order.assignment_id,
      assignmentStatus: order.assignment_status,
      orderNumber: order.order_number,
      orderStatus: order.order_status,
      totalAmount: this._toNumber(order.total_amount, 0),
      paymentMethod: order.payment_method,
      riderEarning: this._toNumber(order.earnings, 0),
      baseEarning: this._toNumber(order.base_earning, this._toNumber(order.earnings, 0)),
      distanceBonus: this._toNumber(order.distance_bonus, 0),
      estimatedDistance: estimatedDistance,
      estimatedDuration,
      offerTimeoutSeconds,
      offerExpiresAt,
      isOfferActive,
      customerAddress: {
        name: this._firstNonEmpty(
          order.customer_name,
          customerAddressRaw.name,
          customerAddressRaw.contactName,
          customerAddressRaw.contact_name,
          'Customer'
        ),
        address: this._resolveAddressText(customerAddressRaw),
        landmark: this._firstNonEmpty(customerAddressRaw.landmark),
        phone: this._firstNonEmpty(order.customer_phone, customerAddressRaw.phone),
        lat: customerLat,
        lng: customerLng,
      },
      storeAddress: {
        name: store?.name || 'Bakaloo Store',
        address: store?.address || 'Assigned pickup hub',
        landmark: '',
        phone: store?.phone || '',
        lat: this._toNullableNumber(store?.lat),
        lng: this._toNullableNumber(store?.lng),
      },
      items: this._parseItems(order.items),
    }
  }

  _parseAddress(value) {
    if (!value) return {}
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch (_) {
        return { address: value }
      }
    }
    if (typeof value === 'object') return value
    return {}
  }

  _parseItems(value) {
    if (!value) return []
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
      } catch (_) {
        return []
      }
    }
    return []
  }

  _resolveAddressText(address) {
    const direct = this._firstNonEmpty(
      address?.address,
      address?.fullAddress,
      address?.full_address,
      address?.formattedAddress,
      address?.formatted_address,
      address?.addressLine1,
      address?.address_line1,
      address?.address_line_1,
      address?.address_line
    )
    if (direct) return direct

    const parts = [
      this._firstNonEmpty(
        address?.addressLine1,
        address?.address_line1,
        address?.address_line_1,
        address?.address_line
      ),
      this._firstNonEmpty(
        address?.addressLine2,
        address?.address_line2,
        address?.address_line_2
      ),
      this._firstNonEmpty(address?.area),
      this._firstNonEmpty(address?.city),
      this._firstNonEmpty(address?.state),
      this._firstNonEmpty(
        address?.pincode,
        address?.postalCode,
        address?.postal_code
      ),
    ].filter(Boolean)

    return parts.length > 0 ? parts.join(', ') : 'Delivery address unavailable'
  }

  _firstNonEmpty(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `${value}`
      }
    }
    return ''
  }

  _toNullableNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  _toNumber(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
}
