import { query, getClient } from '../../config/database.js'

/**
 * Delivery Calendar repository — the real, admin-managed replacement for
 * the hardcoded 7-day/fixed-window generator that used to live in
 * `orders/delivery-slots.routes.js`. Two-tier model (migration 072):
 *   - `delivery_calendar_weekly_template` — admin's recurring "every Monday
 *     has these slots" definition, edited rarely.
 *   - `delivery_calendar_days` + `delivery_calendar_slots` — materialized
 *     concrete dates the customer actually books against, generated
 *     forward from the template and independently overridable per date
 *     (holiday closures, one-off extra slots) without touching the template.
 */

// node-postgres serializes TIME columns as 'HH:MM:SS' by default, but the
// admin write-side schema (delivery-calendar.schema.js) only accepts
// 'HH:MM' — formatting here with to_char() keeps every read the exact
// shape a subsequent write will accept, so round-tripping an unedited row
// through the dashboard's "Save changes" (which resubmits the whole week)
// never fails validation on rows the admin didn't touch.
const TEMPLATE_COLUMNS = `
  id, weekday, is_available,
  to_char(start_time, 'HH24:MI') AS start_time,
  to_char(end_time, 'HH24:MI') AS end_time,
  label, display_order
`

const DAY_COLUMNS = `
  id, calendar_date, is_available, note, updated_at, updated_by
`

const SLOT_COLUMNS = `
  id, calendar_day_id,
  to_char(start_time, 'HH24:MI') AS start_time,
  to_char(end_time, 'HH24:MI') AS end_time,
  label, is_active, display_order
`

export class DeliveryCalendarRepository {
  // ── Weekly template ──────────────────────────────────────────────────

  async getWeeklyTemplate() {
    const { rows } = await query(
      `SELECT ${TEMPLATE_COLUMNS} FROM delivery_calendar_weekly_template
       ORDER BY weekday ASC, display_order ASC`
    )
    return rows
  }

  /** Replace the entire template atomically (admin submits the full week each save). */
  async replaceWeeklyTemplate(rows) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM delivery_calendar_weekly_template')
      for (const row of rows) {
        await client.query(
          `INSERT INTO delivery_calendar_weekly_template
             (weekday, is_available, start_time, end_time, label, display_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            row.weekday,
            row.is_available !== false,
            row.start_time,
            row.end_time,
            row.label,
            row.display_order || 0,
          ]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return this.getWeeklyTemplate()
  }

  // ── Materialized days + slots ────────────────────────────────────────

  /** Days (with their slots) in a date range, inclusive, ascending. */
  async getDaysInRange(fromDate, toDate) {
    const { rows: days } = await query(
      `SELECT ${DAY_COLUMNS} FROM delivery_calendar_days
       WHERE calendar_date BETWEEN $1 AND $2
       ORDER BY calendar_date ASC`,
      [fromDate, toDate]
    )
    if (days.length === 0) return []

    const dayIds = days.map((d) => d.id)
    const { rows: slots } = await query(
      `SELECT ${SLOT_COLUMNS} FROM delivery_calendar_slots
       WHERE calendar_day_id = ANY($1::uuid[])
       ORDER BY display_order ASC, start_time ASC`,
      [dayIds]
    )

    const slotsByDay = new Map()
    for (const slot of slots) {
      const list = slotsByDay.get(slot.calendar_day_id) || []
      list.push(slot)
      slotsByDay.set(slot.calendar_day_id, list)
    }

    return days.map((day) => ({ ...day, slots: slotsByDay.get(day.id) || [] }))
  }

  async getDayByDate(date) {
    const { rows } = await query(
      `SELECT ${DAY_COLUMNS} FROM delivery_calendar_days WHERE calendar_date = $1`,
      [date]
    )
    return rows[0] || null
  }

  /** Latest generated date — the real "how far forward has admin generated" horizon. */
  async getMaxGeneratedDate() {
    const { rows } = await query(
      `SELECT MAX(calendar_date) AS max_date FROM delivery_calendar_days`
    )
    return rows[0]?.max_date || null
  }

  /** Insert a materialized day (idempotent — no-op if the date already exists). */
  async ensureDay(date, { isAvailable = true } = {}) {
    const { rows } = await query(
      `INSERT INTO delivery_calendar_days (calendar_date, is_available)
       VALUES ($1, $2)
       ON CONFLICT (calendar_date) DO NOTHING
       RETURNING ${DAY_COLUMNS}`,
      [date, isAvailable]
    )
    if (rows[0]) return rows[0]
    return this.getDayByDate(date)
  }

  async insertSlotsForDay(dayId, slots) {
    for (const slot of slots) {
      await query(
        `INSERT INTO delivery_calendar_slots
           (calendar_day_id, start_time, end_time, label, is_active, display_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [dayId, slot.start_time, slot.end_time, slot.label, true, slot.display_order || 0]
      )
    }
  }

  /**
   * Materialized days from `fromDate` forward that were purely
   * template-generated (never individually overridden via
   * `upsertDayOverride`, which always stamps `updated_by`) — the set it's
   * safe to resync when the admin edits the weekly template, without
   * clobbering a deliberate one-off holiday-closure/extra-slot override.
   */
  async getRegeneratableDaysFromDate(fromDate) {
    const { rows } = await query(
      `SELECT ${DAY_COLUMNS} FROM delivery_calendar_days
       WHERE calendar_date >= $1 AND updated_by IS NULL
       ORDER BY calendar_date ASC`,
      [fromDate]
    )
    return rows
  }

  /** Replace a day's is_available + slots atomically (template resync). */
  async replaceSlotsForDay(dayId, isAvailable, slots) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE delivery_calendar_days SET is_available = $1, updated_at = NOW() WHERE id = $2`,
        [isAvailable, dayId]
      )
      await client.query('DELETE FROM delivery_calendar_slots WHERE calendar_day_id = $1', [dayId])
      for (const slot of slots) {
        await client.query(
          `INSERT INTO delivery_calendar_slots
             (calendar_day_id, start_time, end_time, label, is_active, display_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [dayId, slot.start_time, slot.end_time, slot.label, true, slot.display_order || 0]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /** Admin override for one specific date: availability + note, and optionally replace its slots. */
  async upsertDayOverride(date, { is_available, note, updatedBy, slots }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO delivery_calendar_days (calendar_date, is_available, note, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (calendar_date) DO UPDATE
           SET is_available = $2, note = $3, updated_by = $4, updated_at = NOW()
         RETURNING ${DAY_COLUMNS}`,
        [date, is_available !== false, note || null, updatedBy || null]
      )
      const day = rows[0]

      if (Array.isArray(slots)) {
        await client.query('DELETE FROM delivery_calendar_slots WHERE calendar_day_id = $1', [day.id])
        for (const slot of slots) {
          await client.query(
            `INSERT INTO delivery_calendar_slots
               (calendar_day_id, start_time, end_time, label, is_active, display_order)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [day.id, slot.start_time, slot.end_time, slot.label, slot.is_active !== false, slot.display_order || 0]
          )
        }
      }

      await client.query('COMMIT')
      return day
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}
