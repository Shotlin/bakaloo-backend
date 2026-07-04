import { DeliveryCalendarRepository } from './delivery-calendar.repository.js'
import { getStoreStatusService } from '../store-status/store-status.routes.js'
import { logger } from '../../config/logger.js'

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000 // UTC+5:30 — same constant the old
// hardcoded generator (orders/delivery-slots.routes.js, now removed) used,
// kept identical so "today" means the same thing before and after this change.
const MIN_NOTICE_MS = 30 * 60 * 1000 // same 30-minute cutoff as before
const DAY_LABELS = ['Today', 'Tomorrow']
const DEFAULT_FORWARD_DAYS = 30

function istMidnightUtcMs(nowMs, dayOffset) {
  const istDate = new Date(nowMs + IST_OFFSET_MS)
  return (
    Date.UTC(
      istDate.getUTCFullYear(),
      istDate.getUTCMonth(),
      istDate.getUTCDate() + dayOffset,
      0, 0, 0, 0
    ) - IST_OFFSET_MS
  )
}

function toDateString(utcMs) {
  const d = new Date(utcMs + IST_OFFSET_MS)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function dayLabelFor(dayOffset, utcMs) {
  if (dayOffset < DAY_LABELS.length) return DAY_LABELS[dayOffset]
  const d = new Date(utcMs + IST_OFFSET_MS)
  return d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' })
}

/**
 * Delivery Calendar service — replaces the hardcoded 7-day/fixed-window
 * generator that used to live in `orders/delivery-slots.routes.js` (deleted)
 * with a real, admin-managed calendar. Two tiers: a recurring weekly
 * template the admin edits rarely, and materialized concrete days/slots
 * the customer actually books against (generated forward from the
 * template, independently overridable per date).
 */
export class DeliveryCalendarService {
  constructor(repository = new DeliveryCalendarRepository(), storeStatusService = null) {
    this.repo = repository
    // Lazily resolved so tests can inject a fake without importing the
    // store-status module's singleton wiring.
    this._storeStatusService = storeStatusService
  }

  get storeStatusService() {
    return this._storeStatusService || getStoreStatusService()
  }

  // ── Public read path (GET /api/v1/delivery/slots) ───────────────────

  /**
   * @param {number} numDays - 1..60
   * @returns {Promise<{timezone: string, days: Array}>} same response
   *   shape the old hardcoded generator produced, so mobile's
   *   DeliverySlotDayEntity/DeliverySlotEntity need zero changes.
   */
  async getAvailableDays(numDays = 7, atUtc = new Date()) {
    const nowMs = atUtc.getTime()
    const fromDateStr = toDateString(istMidnightUtcMs(nowMs, 0))
    const toDateStr = toDateString(istMidnightUtcMs(nowMs, numDays - 1))

    const materializedDays = await this.repo.getDaysInRange(fromDateStr, toDateStr)
    const byDate = new Map(materializedDays.map((d) => [this._dateKey(d.calendar_date), d]))

    // Closed-store override: a manually-closed store blocks TODAY's ASAP
    // ordering (enforced in orders.service.js), but scheduled delivery for
    // FUTURE days should still be bookable — so this only ever suppresses
    // today's slots, not the whole calendar.
    const { isOpen } = await this.storeStatusService.isOpen(atUtc)

    const days = []
    for (let dayOffset = 0; dayOffset < numDays; dayOffset++) {
      const dayStartUtcMs = istMidnightUtcMs(nowMs, dayOffset)
      const dateStr = toDateString(dayStartUtcMs)
      const dayLabel = dayLabelFor(dayOffset, dayStartUtcMs)
      const materialized = byDate.get(dateStr)

      const dayClosed = materialized ? !materialized.is_available : false
      const slots = (materialized?.slots || []).map((slot) => {
        const slotStartUtcMs = dayStartUtcMs + this._timeToMs(slot.start_time)
        const slotEndUtcMs = dayStartUtcMs + this._timeToMs(slot.end_time)
        const pastCutoff = slotStartUtcMs <= nowMs + MIN_NOTICE_MS
        const storeClosedToday = dayOffset === 0 && !isOpen
        const available = slot.is_active && !dayClosed && !pastCutoff && !storeClosedToday

        let reason = null
        if (!slot.is_active || dayClosed) reason = materialized?.note || 'Not available on this date'
        else if (storeClosedToday) reason = 'Store is currently closed'
        else if (pastCutoff) reason = 'This time slot has passed'

        return {
          id: `${new Date(slotStartUtcMs).toISOString()}_${new Date(slotEndUtcMs).toISOString()}`,
          label: slot.label,
          start: new Date(slotStartUtcMs).toISOString(),
          end: new Date(slotEndUtcMs).toISOString(),
          available,
          reason,
        }
      })

      days.push({ date: dateStr, label: dayLabel, slots })
    }

    return { timezone: 'Asia/Kolkata', days }
  }

  /** The furthest date the calendar has been generated to (null if never generated). */
  async getMaxGeneratedDate() {
    return this.repo.getMaxGeneratedDate()
  }

  // ── Generation (admin-triggered + worker-scheduled) ──────────────────

  /**
   * Materialize `numDays` forward from today using the weekly template.
   * Idempotent — `ensureDay` no-ops for dates that already exist, so this
   * is safe to call repeatedly (worker tick, admin "Generate" button, or
   * the lazy self-heal below) without duplicating rows.
   */
  async generateForwardDays(numDays = DEFAULT_FORWARD_DAYS, atUtc = new Date()) {
    const template = await this.repo.getWeeklyTemplate()
    if (template.length === 0) {
      logger.warn('delivery_calendar_weekly_template is empty — nothing to generate')
      return { generated: 0 }
    }

    const templateByWeekday = new Map()
    for (const row of template) {
      const list = templateByWeekday.get(row.weekday) || []
      list.push(row)
      templateByWeekday.set(row.weekday, list)
    }

    const nowMs = atUtc.getTime()
    let generated = 0
    for (let dayOffset = 0; dayOffset < numDays; dayOffset++) {
      const dayStartUtcMs = istMidnightUtcMs(nowMs, dayOffset)
      const dateStr = toDateString(dayStartUtcMs)
      const istWeekday = new Date(dayStartUtcMs + IST_OFFSET_MS).getUTCDay()
      const windowsForDay = templateByWeekday.get(istWeekday) || []

      const existing = await this.repo.getDayByDate(dateStr)
      if (existing) continue // never overwrite an admin's per-date override

      const isAvailable = windowsForDay.some((w) => w.is_available)
      const day = await this.repo.ensureDay(dateStr, { isAvailable })
      if (isAvailable) {
        await this.repo.insertSlotsForDay(
          day.id,
          windowsForDay
            .filter((w) => w.is_available)
            .map((w) => ({
              start_time: w.start_time,
              end_time: w.end_time,
              label: w.label,
              display_order: w.display_order,
            }))
        )
      }
      generated += 1
    }

    logger.info({ generated, numDays }, 'Delivery calendar generated forward')
    return { generated }
  }

  // ── Admin CRUD ────────────────────────────────────────────────────────

  async getWeeklyTemplate() {
    return this.repo.getWeeklyTemplate()
  }

  async replaceWeeklyTemplate(rows) {
    return this.repo.replaceWeeklyTemplate(rows)
  }

  async getDaysInRange(fromDate, toDate) {
    return this.repo.getDaysInRange(fromDate, toDate)
  }

  async setDayOverride(date, payload) {
    return this.repo.upsertDayOverride(date, payload)
  }

  // ── helpers ───────────────────────────────────────────────────────────

  _dateKey(value) {
    // pg returns DATE columns as JS Date objects (midnight UTC) or strings
    // depending on driver config — normalize both to YYYY-MM-DD.
    if (value instanceof Date) {
      return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
    }
    return String(value).slice(0, 10)
  }

  _timeToMs(value) {
    // pg TIME columns come back as 'HH:MM:SS'
    const [h, m, s] = String(value).split(':').map(Number)
    return (h * 3600 + m * 60 + (s || 0)) * 1000
  }
}
