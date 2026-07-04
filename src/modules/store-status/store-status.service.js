import { StoreStatusRepository } from './store-status.repository.js'
import { logger } from '../../config/logger.js'
import { getSocketIo } from '../../plugins/socketio.plugin.js'
import { emit as emitAudit } from '../../utils/audit-log.js'

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000 // UTC+5:30 — same constant used by
// the delivery-slot generator (src/modules/orders/delivery-slots.routes.js)
// so the two stay consistent about what "today" means.

const WEEKDAY_KEYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]

/**
 * Store Status service — the "is the storefront open right now" evaluator.
 *
 * This is genuinely new logic: nothing in the codebase computed this before
 * migration 071 (confirmed via exhaustive grep across the backend). Every
 * other module (delivery calendar, closed-store checkout gate, the closed
 * banner) is expected to call `isOpen()` here rather than re-implement the
 * evaluation — see the Phase 1 plan for the full list of future callers.
 *
 * Priority order: manual_override_status (if set) > weekly_hours > fail-open.
 * Fail-open is a deliberate product decision (confirmed with the store
 * owner): missing/malformed weekly_hours must never silently block ASAP
 * ordering the moment this ships, since no shop has ever had real hours
 * data validated before now.
 */
export class StoreStatusService {
  constructor(repository = new StoreStatusRepository()) {
    this.repo = repository
  }

  /**
   * @param {Date} [atUtc] - instant to evaluate against, defaults to now.
   * @returns {Promise<{isOpen: boolean, source: string, reason: string|null}>}
   */
  async isOpen(atUtc = new Date()) {
    const row = await this.repo.getStatus()
    if (!row) {
      // Table should always have exactly one seeded row (migration 071) —
      // this branch is defensive only. Fail-open per the confirmed default.
      logger.warn('store_status row missing — failing open')
      return { isOpen: true, source: 'DEFAULT', reason: null }
    }

    if (row.manual_override_status) {
      return {
        isOpen: row.manual_override_status === 'OPEN',
        source: 'MANUAL_OVERRIDE',
        reason: row.manual_override_note || null,
      }
    }

    return this._evaluateWeeklySchedule(row.weekly_hours, atUtc)
  }

  /**
   * Pure function: evaluate a weekly_hours JSON blob against an instant,
   * IST-aware. Exposed for direct unit testing.
   * @private
   */
  _evaluateWeeklySchedule(weeklyHours, atUtc) {
    const hours = weeklyHours && typeof weeklyHours === 'object' ? weeklyHours : {}

    const istMs = atUtc.getTime() + IST_OFFSET_MS
    const istDate = new Date(istMs)
    const weekday = WEEKDAY_KEYS[istDate.getUTCDay()]
    const dayConfig = hours[weekday]

    if (!dayConfig || typeof dayConfig !== 'object') {
      logger.warn({ weekday }, 'store_status.weekly_hours missing entry for weekday — failing open')
      return { isOpen: true, source: 'DEFAULT', reason: null }
    }

    if (dayConfig.closed === true) {
      return { isOpen: false, source: 'WEEKLY_SCHEDULE', reason: `Closed on ${weekday}` }
    }

    const openMinutes = this._parseTimeToMinutes(dayConfig.open)
    const closeMinutes = this._parseTimeToMinutes(dayConfig.close)
    if (openMinutes === null || closeMinutes === null) {
      logger.warn({ weekday, dayConfig }, 'store_status.weekly_hours has malformed open/close time — failing open')
      return { isOpen: true, source: 'DEFAULT', reason: null }
    }

    const nowMinutesIst =
      istDate.getUTCHours() * 60 + istDate.getUTCMinutes()

    const isOpen = nowMinutesIst >= openMinutes && nowMinutesIst < closeMinutes
    return {
      isOpen,
      source: 'WEEKLY_SCHEDULE',
      reason: isOpen ? null : `Outside hours (${dayConfig.open}–${dayConfig.close})`,
    }
  }

  /** @private "HH:MM" -> minutes since midnight, or null if malformed. */
  _parseTimeToMinutes(value) {
    if (typeof value !== 'string') return null
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (!match) return null
    const h = Number(match[1])
    const m = Number(match[2])
    if (h < 0 || h > 23 || m < 0 || m > 59) return null
    return h * 60 + m
  }

  async setOverride({ status, note, adminId }) {
    const updated = await this.repo.setOverride({ status: status || null, note, adminId })
    this._broadcastStoreStatusChanged()
    await this._syncLastKnownState()
    return updated
  }

  async updateWeeklyHours(weeklyHours) {
    const updated = await this.repo.updateWeeklyHours(weeklyHours)
    this._broadcastStoreStatusChanged()
    await this._syncLastKnownState()
    return updated
  }

  async updateClosedBannerImage(imageUrl) {
    const updated = await this.repo.updateClosedBannerImage(imageUrl)
    this._broadcastStoreStatusChanged()
    return updated
  }

  /**
   * Called every minute by the store-status scheduler worker
   * (src/workers/store-status-scheduler.worker.js). Detects when the
   * *effective* open/closed state (manual override still wins, exactly
   * like isOpen()) has flipped since the last tick — the case that
   * matters is a WEEKLY_SCHEDULE boundary crossing with no admin action
   * at all (e.g. closing time passes at 9pm). When that happens:
   *   - broadcasts the same live "instant reflect" signal an admin's own
   *     override/weekly-hours edit already triggers, so every connected
   *     customer app updates immediately instead of waiting for its next
   *     unrelated fetch or a manual pull-to-refresh/relaunch.
   *   - writes a system-attributed row to audit_logs (actor_user_id: null)
   *     so the transition is actually visible somewhere in the admin's
   *     history — previously nothing recorded this at all.
   *
   * An admin-driven change (setOverride/updateWeeklyHours) already syncs
   * the baseline itself via _syncLastKnownState(), so this never
   * double-fires for something the admin's own action already
   * broadcast/logged a moment earlier.
   *
   * @returns {Promise<{isOpen: boolean, source: string, reason: string|null}|null>}
   *   null when nothing changed (or this is the very first tick after
   *   deploy, which only establishes a baseline).
   */
  async checkForAutomaticTransition() {
    const status = await this.isOpen()
    const result = await this.repo.claimStateTransition(status.isOpen)
    if (!result || result.previousValue === null) return null

    logger.info(
      { isOpen: status.isOpen, source: status.source, reason: status.reason },
      'Store status auto-transitioned'
    )

    this._broadcastStoreStatusChanged()

    emitAudit(status.isOpen ? 'store_status_auto_opened' : 'store_status_auto_closed', {
      target_type: 'store_status',
      actor_role: 'SYSTEM',
      after: { isOpen: status.isOpen, source: status.source, reason: status.reason },
    })

    return status
  }

  /**
   * Silently records the current effective state as "already known" right
   * after an admin-driven change — so the scheduler worker's next tick
   * doesn't mistake the admin's own action for an automatic transition
   * and double broadcast/log it.
   * @private
   */
  async _syncLastKnownState() {
    try {
      const status = await this.isOpen()
      await this.repo.claimStateTransition(status.isOpen)
    } catch (err) {
      logger.warn({ err: err.message }, 'Store status baseline sync failed (non-blocking)')
    }
  }

  /**
   * Broadcast to every connected customer app instantly (via the same
   * `themes:live` room every authenticated socket already joins) so an
   * admin's override/weekly-hours/closed-banner change reflects immediately
   * — no manual pull-to-refresh or app relaunch needed. Mirrors the exact
   * pattern `emitThemeUpdate`/`emitSectionUpdate` already use for the same
   * "push a lightweight signal, let the client refetch" approach.
   * @private
   */
  _broadcastStoreStatusChanged() {
    try {
      const io = getSocketIo()
      if (!io) return
      io.to('themes:live').emit('store:status:update', {
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      logger.warn({ err: err.message }, 'Store status broadcast failed (non-blocking)')
    }
  }

  /** The admin-uploaded "we are closed" banner image, or null if never set. */
  async getClosedBannerImageUrl() {
    const row = await this.repo.getStatus()
    return row?.closed_banner_image_url || null
  }

  async getFullStatus() {
    const row = await this.repo.getStatus()
    const status = await this.isOpen()
    return {
      ...status,
      weeklyHours: row?.weekly_hours || {},
      closedBannerImageUrl: row?.closed_banner_image_url || null,
    }
  }

  /**
   * Next 7 days' open/closed status + hours, IST-aware, for the mobile
   * "view store hours" surface. Only today's entry reflects a manual
   * override (an override is inherently a "right now" statement, not a
   * standing rule for future days) — every other day is evaluated purely
   * against the weekly schedule, same fail-open behavior as isOpen().
   * @param {Date} [fromUtc]
   * @returns {Promise<Array<{date: string, weekday: string, isOpen: boolean, open: string|null, close: string|null, reason: string|null}>>}
   */
  async getNext7DaysAvailability(fromUtc = new Date()) {
    const row = await this.repo.getStatus()
    const weeklyHours = row?.weekly_hours || {}
    const days = []

    for (let offset = 0; offset < 7; offset++) {
      const atUtc = new Date(fromUtc.getTime() + offset * 24 * 60 * 60 * 1000)
      const istMs = atUtc.getTime() + IST_OFFSET_MS
      const istDate = new Date(istMs)
      const weekday = WEEKDAY_KEYS[istDate.getUTCDay()]
      const dateStr = istDate.toISOString().slice(0, 10)

      if (offset === 0 && row?.manual_override_status) {
        days.push({
          date: dateStr,
          weekday,
          isOpen: row.manual_override_status === 'OPEN',
          open: null,
          close: null,
          reason: row.manual_override_note || null,
        })
        continue
      }

      const dayConfig = weeklyHours[weekday]
      if (!dayConfig || typeof dayConfig !== 'object' || dayConfig.closed === true) {
        days.push({
          date: dateStr,
          weekday,
          isOpen: !dayConfig || typeof dayConfig !== 'object', // fail-open when missing/malformed
          open: null,
          close: null,
          reason: dayConfig?.closed === true ? `Closed on ${weekday}` : null,
        })
        continue
      }

      days.push({
        date: dateStr,
        weekday,
        isOpen: true,
        open: dayConfig.open || null,
        close: dayConfig.close || null,
        reason: null,
      })
    }

    return days
  }
}
