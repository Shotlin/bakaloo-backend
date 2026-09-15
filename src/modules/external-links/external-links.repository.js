import { query } from '../../config/database.js'

/**
 * External Links repository — thin read/write access into the generic
 * `app_settings` key/value table for the admin-configurable destination
 * URLs (business transaction portal, games hub). Same shape as
 * wallet-settings.repository.js — that module's own precedent for storing
 * a handful of named settings in app_settings instead of a dedicated table.
 */
export class ExternalLinksRepository {
  async getMany(keys) {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
      [keys]
    )
    return rows.reduce((acc, row) => {
      acc[row.key] = row.value
      return acc
    }, {})
  }

  async upsert(key, value) {
    const { rows } = await query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = $2::jsonb, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value)]
    )
    return rows[0]
  }
}
