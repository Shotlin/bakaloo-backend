/**
 * Ola Maps (https://maps.olakrutrim.com) proxy — reads the API key from
 * `ola_maps_settings` via OlaMapsSettingsRepository (admin-managed, see
 * src/modules/ola-maps-settings) instead of an env var, so the dashboard
 * is the single source of truth and a key change/rotation takes effect
 * immediately (repository cache invalidates on save), no redeploy.
 *
 * Test module: sits alongside the mobile app's existing free
 * OSM/Nominatim setup while accuracy is evaluated, before deciding
 * whether to switch.
 */
import { logger } from '../../config/logger.js'
import { OlaMapsSettingsRepository } from '../ola-maps-settings/ola-maps-settings.repository.js'

const BASE_URL = 'https://api.olamaps.io'
const REQUEST_TIMEOUT_MS = 8000
const DEFAULT_STYLE_NAME = 'default-light-standard'

export class OlaMapsService {
  constructor(settingsRepository = new OlaMapsSettingsRepository()) {
    this.settingsRepository = settingsRepository
  }

  async isConfigured() {
    return Boolean(await this._getApiKey())
  }

  /**
   * A ready-to-use MapLibre style URL (API key already embedded in the
   * query string) plus whether one could be issued. One settings read for
   * both, so the controller doesn't pay for it twice.
   */
  async getStyleInfo(styleName = DEFAULT_STYLE_NAME) {
    const apiKey = await this._getApiKey()
    if (!apiKey) {
      return { configured: false, styleUrl: null }
    }
    const url = new URL(`${BASE_URL}/tiles/vector/v1/styles/${styleName}/style.json`)
    url.searchParams.set('api_key', apiKey)
    return { configured: true, styleUrl: url.toString() }
  }

  async geocode(address) {
    const apiKey = await this._getApiKey()
    if (!apiKey) {
      return null
    }
    return this._get('/places/v1/geocode', { address, language: 'en' }, apiKey)
  }

  async reverseGeocode(lat, lng) {
    const apiKey = await this._getApiKey()
    if (!apiKey) {
      return null
    }
    return this._get('/places/v1/reverse-geocode', {
      latlng: `${lat},${lng}`,
      language: 'en',
    }, apiKey)
  }

  async _getApiKey() {
    const row = await this.settingsRepository.get()
    return row?.is_enabled && row?.api_key ? row.api_key : null
  }

  async _get(path, params, apiKey) {
    const url = new URL(`${BASE_URL}${path}`)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set('api_key', apiKey)

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await res.json().catch(() => null)

      if (!res.ok) {
        logger.warn({ status: res.status, path, body }, 'Ola Maps request failed')
        return null
      }

      return body
    } catch (err) {
      logger.warn({ err: err.message, path }, 'Ola Maps request errored')
      return null
    }
  }
}
