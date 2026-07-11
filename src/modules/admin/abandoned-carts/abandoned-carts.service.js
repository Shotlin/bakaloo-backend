import { AdminAbandonedCartsRepository } from './abandoned-carts.repository.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { NotificationsService } from '../../notifications/notifications.service.js'
import { CouponsRepository } from '../../coupons/coupons.repository.js'
import { CouponsService } from '../../coupons/coupons.service.js'

const repo = new AdminAbandonedCartsRepository()
const couponsService = new CouponsService(new CouponsRepository())

export class AdminAbandonedCartsService {
  async list({ page = 1, limit = 20, search, status, minValue, maxValue, sortBy, sortOrder }) {
    const offset = (page - 1) * limit
    return repo.findAll({ offset, limit, search, status, minValue, maxValue, sortBy, sortOrder })
  }

  async getSummary() {
    return repo.getSummary()
  }

  async getDetail(id) {
    return repo.findById(id)
  }

  /**
   * Sends a reminder for one abandoned-cart episode via the app's real,
   * existing single-send notification primitive (push + in-app +
   * socket) — the same one orders/wallet/cashback use everywhere else.
   * No new send path is introduced.
   */
  async sendReminder(id, { title, body, imageUrl, deepLink }, adminUserId, fastify) {
    const episode = await repo.findById(id)
    if (!episode) {
      return { success: false, message: 'Abandoned cart not found', code: 'NOT_FOUND' }
    }

    const notifService = new NotificationsService(new NotificationsRepository(), fastify)
    const notification = await notifService.sendNotification(episode.user.id, {
      title,
      body,
      type: 'abandoned_cart',
      data: { abandonedCartId: id, deepLink: deepLink || null, imageUrl: imageUrl || null },
    })

    await repo.recordNotification(id, {
      notificationId: notification.id,
      sentBy: adminUserId,
    })

    return { success: true, notificationId: notification.id }
  }

  /**
   * Two modes, both thin orchestration over the ALREADY-EXISTING coupon
   * system (coupon_target_users / target_type='INDIVIDUAL') — no new
   * coupon engine, no new discount logic:
   *   - create: build a brand-new coupon, forced INDIVIDUAL-targeted to
   *     just this episode's user (client input for targetType/
   *     targetUserIds is ignored/overridden server-side).
   *   - assign: add this user to an already-existing coupon's target
   *     list via the non-destructive addTargetUser (does not disturb
   *     other users already targeted by that coupon).
   */
  async issueCoupon(id, payload, actor) {
    const episode = await repo.findById(id)
    if (!episode) {
      return { success: false, message: 'Abandoned cart not found', code: 'NOT_FOUND' }
    }
    const userId = episode.user.id

    if (payload.couponId) {
      const couponsRepo = new CouponsRepository()
      await couponsRepo.addTargetUser(payload.couponId, userId)
      await repo.recordCoupon(id, { couponId: payload.couponId, issuedBy: actor.userId })
      return { success: true, couponId: payload.couponId }
    }

    const couponData = {
      ...payload,
      targetType: 'INDIVIDUAL',
      targetUserIds: [userId],
      createdBy: actor.userId,
    }
    delete couponData.couponId

    const result = await couponsService.create(couponData, actor)
    if (!result.success) {
      return result
    }

    await repo.recordCoupon(id, { couponId: result.coupon.id, issuedBy: actor.userId })
    return { success: true, couponId: result.coupon.id, code: result.coupon.code }
  }
}
