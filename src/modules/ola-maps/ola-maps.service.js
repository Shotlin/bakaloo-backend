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
 *
 * Style rewriting (buildProxiedStyle): Ola's style.json only carries
 * api_key on itself — the `glyphs`/`sprite` templates and each vector
 * source's external TileJSON (and THAT TileJSON's own `tiles` array) come
 * back with no key on them at all, so a MapLibreMap pointed straight at
 * Ola's style.json loads a blank map — every actual tile/glyph/sprite
 * request 401s. Confirmed by hand: `.../data/planet.json` (a source's
 * TileJSON) returns 401 with no key, 200 with one appended, and neither
 * the style.json nor that TileJSON embed the key on their own.
 * `buildProxiedStyle` fetches the style once, resolves each vector
 * source's TileJSON server-side, and inlines the key into every nested
 * URL template before handing the whole thing back — see
 * ola-maps.controller.js#styleJson for the public route that serves this.
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
   * Whether a style can be served, plus the URL to fetch it from — our
   * own public style.json passthrough (see styleJson below), not Ola's
   * URL directly, since only our route does the key-stitching rewrite.
   */
  async getStyleInfo(publicBaseUrl, styleName = DEFAULT_STYLE_NAME) {
    const apiKey = await this._getApiKey()
    if (!apiKey) {
      return { configured: false, styleUrl: null }
    }
    return {
      configured: true,
      styleUrl: `${publicBaseUrl}/api/v1/maps/ola/style.json?style=${encodeURIComponent(styleName)}`,
    }
  }

  /**
   * Fetches Ola's style.json plus every vector source's TileJSON
   * (server-side, using our stored key) and returns a single
   * self-contained style document with the key stitched into every
   * nested URL — glyphs, sprite, and each source's tile template.
   * Public route, no app auth: the native map engine that consumes this
   * can't attach our bearer token, so protection here is the same as any
   * client-embedded map key (see the security note in this repo's
   * discussion of this module) — rotate the key from the dashboard if
   * it's ever abused.
   */
  async buildProxiedStyle(styleName = DEFAULT_STYLE_NAME) {
    const apiKey = await this._getApiKey()
    if (!apiKey) {
      return null
    }

    const style = await this._fetchJson(
      this._withApiKey(`${BASE_URL}/tiles/vector/v1/styles/${styleName}/style.json`, apiKey)
    )
    if (!style) {
      return null
    }

    if (style.glyphs) {
      style.glyphs = this._withApiKey(style.glyphs, apiKey)
    }
    if (style.sprite) {
      style.sprite = this._withApiKey(style.sprite, apiKey)
    }

    const sources = style.sources || {}
    for (const [name, source] of Object.entries(sources)) {
      if (source?.type !== 'vector' || !source.url) {
        continue
      }

      const tileJson = await this._fetchJson(this._withApiKey(source.url, apiKey))
      if (!tileJson || !Array.isArray(tileJson.tiles)) {
        logger.warn({ name, url: source.url }, 'Ola Maps source TileJSON unavailable, dropping source')
        delete sources[name]
        continue
      }

      sources[name] = {
        type: 'vector',
        tiles: tileJson.tiles.map((tileUrl) => this._withApiKey(tileUrl, apiKey)),
        minzoom: tileJson.minzoom,
        maxzoom: tileJson.maxzoom,
        ...(tileJson.bounds ? { bounds: tileJson.bounds } : {}),
        ...(tileJson.attribution ? { attribution: tileJson.attribution } : {}),
      }
    }

    return style
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

  /**
   * Driving route between two points — replaces the OpenRouteService/OSRM
   * lookup the mobile app used to do itself. Ola's response shape mirrors
   * Google's Directions API: total distance/duration live on `legs[0]`
   * (single leg, no intermediate waypoints here), and the route geometry
   * comes back as a Google-encoded polyline string (`overview_polyline`,
   * precision 5) rather than GeoJSON — verified by hand: decoding it at
   * precision 5 reproduces the requested origin/destination almost
   * exactly. Returns null (never throws) on any failure, matching the
   * other methods here — callers should fall back to a straight line.
   */
  async directions(originLat, originLng, destLat, destLng) {
    const apiKey = await this._getApiKey()
    if (!apiKey) {
      return null
    }

    const url = new URL(`${BASE_URL}/routing/v1/directions/basic`)
    url.searchParams.set('origin', `${originLat},${originLng}`)
    url.searchParams.set('destination', `${destLat},${destLng}`)
    url.searchParams.set('api_key', apiKey)

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await res.json().catch(() => null)

      if (!res.ok || body?.status !== 'SUCCESS') {
        logger.warn({ status: res.status, body: body?.status }, 'Ola Maps directions request failed')
        return null
      }

      const route = body?.routes?.[0]
      const leg = route?.legs?.[0]
      if (!route?.overview_polyline || !leg) {
        return null
      }

      return {
        points: this._decodePolyline(route.overview_polyline),
        distanceMeters: Math.round(leg.distance),
        durationSeconds: Math.round(leg.duration),
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Ola Maps directions request errored')
      return null
    }
  }

  /** @private Google/Ola encoded-polyline decoder (precision 5). */
  _decodePolyline(encoded) {
    const factor = 1e5
    let index = 0
    let lat = 0
    let lng = 0
    const points = []

    while (index < encoded.length) {
      let shift = 0
      let result = 0
      let byte
      do {
        byte = encoded.charCodeAt(index++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      lat += result & 1 ? ~(result >> 1) : result >> 1

      shift = 0
      result = 0
      do {
        byte = encoded.charCodeAt(index++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      lng += result & 1 ? ~(result >> 1) : result >> 1

      points.push({ lat: lat / factor, lng: lng / factor })
    }

    return points
  }

  async _getApiKey() {
    const row = await this.settingsRepository.get()
    return row?.is_enabled && row?.api_key ? row.api_key : null
  }

  /** @private Appends api_key to a URL (template placeholders like {z} are left untouched). */
  _withApiKey(rawUrl, apiKey) {
    const [base, query] = rawUrl.split('?')
    const params = new URLSearchParams(query || '')
    params.set('api_key', apiKey)
    return `${base}?${params.toString()}`
  }

  /** @private GET a URL (already carrying its own auth) and parse the JSON body, or null on any failure. */
  async _fetchJson(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!res.ok) {
        logger.warn({ status: res.status, url }, 'Ola Maps request failed')
        return null
      }
      return await res.json()
    } catch (err) {
      logger.warn({ err: err.message, url }, 'Ola Maps request errored')
      return null
    }
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
