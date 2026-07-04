import { success, error } from '../../utils/apiResponse.js'
import { logAdminActivity } from '../../utils/activityLogger.js'
import { replaceWeeklyTemplateSchema, setDayOverrideSchema } from './delivery-calendar.schema.js'

export class DeliveryCalendarController {
  constructor(service) {
    this.service = service
  }

  _formatZodErrors(zodError) {
    return zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
  }

  // GET /api/v1/delivery/slots — public
  async publicSlots(request, reply) {
    const numDays = Math.min(60, Math.max(1, Number(request.query.days) || 7))
    const result = await this.service.getAvailableDays(numDays)
    return reply.code(200).send(success(result, 'Delivery slots fetched'))
  }

  // GET /api/v1/admin/delivery-calendar/template
  async getTemplate(request, reply) {
    const rows = await this.service.getWeeklyTemplate()
    return reply.code(200).send(success({ rows }, 'Weekly template fetched'))
  }

  // PUT /api/v1/admin/delivery-calendar/template
  async putTemplate(request, reply) {
    const parsed = replaceWeeklyTemplateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }
    const rows = await this.service.replaceWeeklyTemplate(parsed.data.rows)
    logAdminActivity(
      request.user?.id,
      'Delivery calendar weekly template updated',
      'delivery_calendar_template',
      null,
      null,
      { rowCount: rows.length },
      request.ip
    )
    return reply.code(200).send(success({ rows }, 'Weekly template updated'))
  }

  // GET /api/v1/admin/delivery-calendar/days?from=&to=
  async getDays(request, reply) {
    const { from, to } = request.query
    if (!from || !to) {
      return reply.code(400).send(error('from and to query params are required', 'VALIDATION_ERROR'))
    }
    const days = await this.service.getDaysInRange(from, to)
    return reply.code(200).send(success({ days }, 'Calendar days fetched'))
  }

  // PATCH /api/v1/admin/delivery-calendar/days/:date
  async patchDay(request, reply) {
    const { date } = request.params
    const parsed = setDayOverrideSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }
    const day = await this.service.setDayOverride(date, {
      ...parsed.data,
      updatedBy: request.user?.id,
    })
    logAdminActivity(
      request.user?.id,
      `Delivery calendar override: ${date}`,
      'delivery_calendar_day',
      day.id,
      null,
      { date, isAvailable: parsed.data.isAvailable, note: parsed.data.note || null },
      request.ip
    )
    return reply.code(200).send(success(day, 'Day override saved'))
  }

  // POST /api/v1/admin/delivery-calendar/generate
  async generate(request, reply) {
    const numDays = Math.min(90, Math.max(1, Number(request.body?.numDays) || 30))
    const result = await this.service.generateForwardDays(numDays)
    return reply.code(200).send(success(result, 'Calendar generated'))
  }
}
