import { OlaMapsSettingsRepository } from './ola-maps-settings.repository.js'

const BASE_URL = 'https://api.olamaps.io'
const REQUEST_TIMEOUT_MS = 8000

/**
 * Ola Maps settings — admin-facing business logic behind the dashboard's
 * "paste key, Test, Save" flow. Saving always re-validates a changed key
 * live before persisting, so a broken key can never be silently enabled
 * and handed to the mobile app.
 */
export class OlaMapsSettingsService {
  constructor(repository = new OlaMapsSettingsRepository()) {
    this.repository = repository
  }

  /** Admin-safe view — never returns the raw key, only a masked tail. */
  async get() {
    const row = await this.repository.get()
    return this._toAdminView(row)
  }

  /** Test a key without saving it — the dashboard's standalone "Test" button. */
  async test(apiKey) {
    return this._testKey(apiKey)
  }

  /**
   * Save settings. `apiKey` and `isEnabled` are both optional:
   *  - `apiKey` omitted           -> key untouched, only `isEnabled` (if given) changes.
   *  - `apiKey` a non-empty string -> re-tested live; only enabled if the test passes.
   *  - `apiKey` an empty string    -> clears the key and disables.
   */
  async save({ apiKey, isEnabled } = {}, updatedBy = null) {
    const current = await this.repository.get()
    const hasNewKey = apiKey !== undefined
    const data = {}
    let testResult = null

    if (hasNewKey) {
      const trimmed = (apiKey || '').trim()
      if (trimmed === '') {
        data.api_key = null
        data.is_enabled = false
        data.last_tested_at = null
        data.last_test_status = null
        data.last_test_message = null
      } else {
        testResult = await this._testKey(trimmed)
        data.api_key = trimmed
        data.last_tested_at = new Date()
        data.last_test_status = testResult.success ? 'SUCCESS' : 'FAILED'
        data.last_test_message = testResult.message
        data.is_enabled = Boolean(isEnabled ?? true) && testResult.success
      }
    } else if (isEnabled !== undefined) {
      data.is_enabled = Boolean(isEnabled) && Boolean(current?.api_key)
    }

    const row = Object.keys(data).length > 0
      ? await this.repository.save(data, updatedBy)
      : current

    return { settings: this._toAdminView(row), test: testResult }
  }

  /** @private Cheap, side-effect-free call (styles listing) just to prove the key works. */
  async _testKey(apiKey) {
    const trimmed = (apiKey || '').trim()
    if (!trimmed) {
      return { success: false, statusCode: null, message: 'API key is required' }
    }

    try {
      const url = new URL(`${BASE_URL}/tiles/vector/v1/styles.json`)
      url.searchParams.set('api_key', trimmed)
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

      if (res.ok) {
        return { success: true, statusCode: res.status, message: 'Connected successfully' }
      }
      if (res.status === 401 || res.status === 403) {
        return { success: false, statusCode: res.status, message: 'Invalid API key' }
      }
      return { success: false, statusCode: res.status, message: `Ola Maps returned HTTP ${res.status}` }
    } catch (err) {
      return { success: false, statusCode: null, message: `Could not reach Ola Maps: ${err.message}` }
    }
  }

  /** @private */
  _toAdminView(row) {
    if (!row) {
      return {
        configured: false,
        isEnabled: false,
        maskedKey: null,
        lastTestedAt: null,
        lastTestStatus: null,
        lastTestMessage: null,
        updatedAt: null,
      }
    }
    return {
      configured: Boolean(row.api_key),
      isEnabled: row.is_enabled,
      maskedKey: this._mask(row.api_key),
      lastTestedAt: row.last_tested_at,
      lastTestStatus: row.last_test_status,
      lastTestMessage: row.last_test_message,
      updatedAt: row.updated_at,
    }
  }

  /** @private */
  _mask(key) {
    if (!key) return null
    if (key.length <= 4) return '••••'
    return `••••${key.slice(-4)}`
  }
}
