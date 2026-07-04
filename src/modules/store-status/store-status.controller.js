import { success, error } from '../../utils/apiResponse.js'
import { logAdminActivity } from '../../utils/activityLogger.js'
import {
  setOverrideSchema,
  updateWeeklyHoursSchema,
  updateClosedBannerImageSchema,
} from './store-status.schema.js'

/**
 * Store Status controller — thin HTTP layer over StoreStatusService.
 */
export class StoreStatusController {
  constructor(service) {
    this.service = service
  }

  /** @private */
  _formatZodErrors(zodError) {
    return zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
  }

  // GET /api/v1/store/status — public, no auth
  async publicStatus(request, reply) {
    const [status, next7Days, closedBannerImageUrl] = await Promise.all([
      this.service.isOpen(),
      this.service.getNext7DaysAvailability(),
      this.service.getClosedBannerImageUrl(),
    ])
    return reply
      .code(200)
      .send(success({ ...status, next7Days, closedBannerImageUrl }, 'Store status fetched'))
  }

  // GET /api/v1/admin/store-status — full detail incl. weekly hours
  async adminStatus(request, reply) {
    const status = await this.service.getFullStatus()
    return reply.code(200).send(success(status, 'Store status fetched'))
  }

  // PUT /api/v1/admin/store-status/override
  async setOverride(request, reply) {
    const parsed = setOverrideSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const before = await this.service.getFullStatus()
    const adminId = request.user?.id
    const updated = await this.service.setOverride({ ...parsed.data, adminId })

    logAdminActivity(
      adminId,
      `Store status override: ${before.source === 'MANUAL_OVERRIDE' ? before.isOpen : 'AUTO'} → ${parsed.data.status || 'AUTO'}`,
      'store_status',
      updated?.id || null,
      { manual_override_status: before.source === 'MANUAL_OVERRIDE' ? (before.isOpen ? 'OPEN' : 'CLOSED') : null },
      { manual_override_status: parsed.data.status || null, note: parsed.data.note || null },
      request.ip
    )

    return reply.code(200).send(success(updated, 'Store status override updated'))
  }

  // PUT /api/v1/admin/store-status/weekly-hours
  async updateWeeklyHours(request, reply) {
    const parsed = updateWeeklyHoursSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const adminId = request.user?.id
    const updated = await this.service.updateWeeklyHours(parsed.data.weeklyHours)

    logAdminActivity(
      adminId,
      'Store weekly hours updated',
      'store_status',
      updated?.id || null,
      null,
      { weekly_hours: parsed.data.weeklyHours },
      request.ip
    )

    return reply.code(200).send(success(updated, 'Weekly hours updated'))
  }

  // PUT /api/v1/admin/store-status/closed-banner
  async updateClosedBannerImage(request, reply) {
    const parsed = updateClosedBannerImageSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const adminId = request.user?.id
    const updated = await this.service.updateClosedBannerImage(parsed.data.imageUrl)

    logAdminActivity(
      adminId,
      'Store closed-banner image updated',
      'store_status',
      updated?.id || null,
      null,
      { closed_banner_image_url: parsed.data.imageUrl },
      request.ip
    )

    return reply.code(200).send(success(updated, 'Closed banner image updated'))
  }
}
