import { query } from '../../config/database.js'

/**
 * Ola Maps settings repository — the single GLOBAL row in
 * `ola_maps_settings` (migration 115), source of truth for both the admin
 * dashboard (src/modules/ola-maps-settings) and the customer-facing proxy
 * (src/modules/ola-maps). A short in-memory cache keeps the mobile app's
 * frequent style-url/geocode calls off the DB; `invalidate()` (called by
 * `save`) clears it immediately so a dashboard save takes effect on the
 * very next request — this cache is module-scoped, so every import of this
 * class across the app shares one copy, not per-instance.
 */

const CACHE_TTL_MS = 30_000

let cache = { value: undefined, expiresAt: 0 }

const COLUMNS = `
  id, api_key, is_enabled, last_tested_at, last_test_status, last_test_message,
  created_at, updated_at, updated_by
`

// Columns the service may update — audit fields are managed here, not the caller.
const UPDATABLE_COLUMNS = [
  'api_key',
  'is_enabled',
  'last_tested_at',
  'last_test_status',
  'last_test_message',
]

export class OlaMapsSettingsRepository {
  /** The single settings row, served from cache when fresh. */
  async get() {
    const now = Date.now()
    if (cache.value !== undefined && now < cache.expiresAt) {
      return cache.value
    }
    const { rows } = await query(`SELECT ${COLUMNS} FROM ola_maps_settings LIMIT 1`)
    const row = rows[0] || null
    cache = { value: row, expiresAt: now + CACHE_TTL_MS }
    return row
  }

  /**
   * Partial update — only the keys present in `data` are touched, so a
   * toggle-only save (no key change) never disturbs api_key or the last
   * test result. Always invalidates the cache.
   */
  async save(data, updatedBy = null) {
    const fields = []
    const params = []
    let idx = 1

    for (const key of UPDATABLE_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        fields.push(`${key} = $${idx++}`)
        params.push(data[key])
      }
    }

    fields.push(`updated_by = $${idx++}`)
    params.push(updatedBy)
    fields.push('updated_at = NOW()')

    const { rows } = await query(
      `UPDATE ola_maps_settings SET ${fields.join(', ')} RETURNING ${COLUMNS}`,
      params
    )
    this.invalidate()
    return rows[0] || null
  }

  invalidate() {
    cache = { value: undefined, expiresAt: 0 }
  }
}
