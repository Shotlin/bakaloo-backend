import { query } from '../../config/database.js'

/**
 * App Version repository — one row per platform (migration 091), seeded
 * for 'android' and 'ios', never created/deleted at runtime.
 */

const COLUMNS = `
  platform, min_supported_build, latest_build, latest_version_name,
  update_message, store_url, updated_at
`

export class AppVersionRepository {
  async getByPlatform(platform) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM app_versions WHERE platform = $1`,
      [platform]
    )
    return rows[0] || null
  }

  async getAll() {
    const { rows } = await query(`SELECT ${COLUMNS} FROM app_versions ORDER BY platform ASC`)
    return rows
  }

  async update(platform, data) {
    const { rows } = await query(
      `UPDATE app_versions
       SET min_supported_build = $2,
           latest_build = $3,
           latest_version_name = $4,
           update_message = $5,
           store_url = $6,
           updated_at = NOW()
       WHERE platform = $1
       RETURNING ${COLUMNS}`,
      [
        platform,
        data.minSupportedBuild,
        data.latestBuild,
        data.latestVersionName,
        data.updateMessage || null,
        data.storeUrl || null,
      ]
    )
    return rows[0] || null
  }
}
