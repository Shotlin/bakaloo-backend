import { query } from '../../config/database.js'

/**
 * Store Status repository — single global "is the storefront open" row.
 *
 * Backed by the `store_status` table (migration 071). This app is a single
 * storefront (confirmed scope), so there is exactly one row, seeded by the
 * migration — never created/deleted at runtime.
 */

const COLUMNS = `
  id, manual_override_status, manual_override_note,
  manual_override_set_at, manual_override_set_by,
  weekly_hours, closed_banner_image_url, updated_at
`

export class StoreStatusRepository {
  /** Fetch the single status row. */
  async getStatus() {
    const { rows } = await query(`SELECT ${COLUMNS} FROM store_status LIMIT 1`)
    return rows[0] || null
  }

  /** Set (or clear, with status=null) the manual open/closed override. */
  async setOverride({ status, note, adminId }) {
    // Every parameter is explicitly cast at every occurrence. Without this,
    // Postgres's parameter-type resolver can fail with "could not determine
    // data type of parameter $1" for a param that only ever appears inside
    // a `$1 IS NULL` check (as in the CASE branches below) — `IS NULL` alone
    // doesn't fix a type, and column-assignment coercion elsewhere in the
    // same statement isn't enough for the resolver to infer it from. Casting
    // removes the ambiguity everywhere instead of relying on inference.
    const { rows } = await query(
      `UPDATE store_status
       SET manual_override_status = $1::varchar,
           manual_override_note = $2::text,
           manual_override_set_at = CASE WHEN $1::varchar IS NULL THEN NULL ELSE NOW() END,
           manual_override_set_by = CASE WHEN $1::varchar IS NULL THEN NULL ELSE $3::uuid END,
           updated_at = NOW()
       RETURNING ${COLUMNS}`,
      [status, note || null, adminId]
    )
    return rows[0] || null
  }

  /** Bulk-replace the weekly hours schedule. */
  async updateWeeklyHours(weeklyHours) {
    const { rows } = await query(
      `UPDATE store_status SET weekly_hours = $1, updated_at = NOW() RETURNING ${COLUMNS}`,
      [JSON.stringify(weeklyHours || {})]
    )
    return rows[0] || null
  }

  /** Set (or clear, with imageUrl=null) the "we are closed" banner image. */
  async updateClosedBannerImage(imageUrl) {
    const { rows } = await query(
      `UPDATE store_status SET closed_banner_image_url = $1, updated_at = NOW() RETURNING ${COLUMNS}`,
      [imageUrl || null]
    )
    return rows[0] || null
  }
}
