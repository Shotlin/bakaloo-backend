import { query } from '../../config/database.js'

/**
 * Commission Settings repository — thin read/write access into the
 * generic `app_settings` key/value table, mirroring
 * wallet-settings.repository.js's getMany/upsert pattern. Riders are
 * moving to salary-based pay; `rider_commission_enabled` gates every new
 * commission write across the codebase without touching historical
 * rider_earnings/rider_payouts rows or dropping any schema.
 */
export class CommissionSettingsRepository {
  async isCommissionEnabled() {
    const { rows } = await query(
      `SELECT value FROM app_settings WHERE key = 'rider_commission_enabled'`
    )
    if (!rows[0]) return false
    const value = rows[0].value
    return value === true || value === 'true'
  }

  async setCommissionEnabled(enabled) {
    const { rows } = await query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('rider_commission_enabled', $1::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = $1::jsonb, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [JSON.stringify(!!enabled)]
    )
    return rows[0]
  }
}
