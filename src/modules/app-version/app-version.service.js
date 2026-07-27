import { AppVersionRepository } from './app-version.repository.js'

/**
 * App Version service — decides whether a given app build must (force) or
 * should (soft) update, and lets the admin dashboard adjust the thresholds.
 *
 * check() fails open: a missing/malformed config, or a client build number
 * that doesn't parse, never forces an update. A backend misconfiguration
 * must never be able to lock every customer out of the app.
 */
export class AppVersionService {
  constructor(repository = new AppVersionRepository()) {
    this.repo = repository
  }

  _format(row) {
    return {
      platform: row.platform,
      minSupportedBuild: row.min_supported_build,
      latestBuild: row.latest_build,
      latestVersionName: row.latest_version_name,
      updateMessage: row.update_message,
      storeUrl: row.store_url,
      updatedAt: row.updated_at,
    }
  }

  async listAll() {
    const rows = await this.repo.getAll()
    return rows.map((row) => this._format(row))
  }

  /**
   * @param {'android'|'ios'} platform
   * @param {number} clientBuild - the requesting app's own build number
   * @returns {Promise<{forceUpdate: boolean, softUpdate: boolean, latestVersionName: string|null, updateMessage: string|null, storeUrl: string|null}>}
   */
  async check(platform, clientBuild) {
    const row = await this.repo.getByPlatform(platform)
    if (!row) {
      return {
        forceUpdate: false,
        softUpdate: false,
        latestVersionName: null,
        updateMessage: null,
        storeUrl: null,
      }
    }

    const config = this._format(row)
    const build = Number(clientBuild)
    const buildIsValid = Number.isFinite(build) && build > 0
    const forceUpdate = buildIsValid && build < config.minSupportedBuild
    const softUpdate = !forceUpdate && buildIsValid && build < config.latestBuild

    return {
      forceUpdate,
      softUpdate,
      latestVersionName: config.latestVersionName,
      updateMessage: config.updateMessage,
      storeUrl: config.storeUrl,
    }
  }

  async update(platform, data) {
    const row = await this.repo.update(platform, data)
    return row ? this._format(row) : null
  }
}
