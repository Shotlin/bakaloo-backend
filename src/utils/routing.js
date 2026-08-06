/**
 * Real road-route distance lookups — never haversine/straight-line.
 *
 * Provider: OpenRouteService (free tier — 2,000 routes/day, no card
 * required: https://openrouteservice.org/dev/#/signup). Returns `null`
 * when ORS_API_KEY isn't configured, when the coordinates are invalid, or
 * when the lookup fails for any reason — callers must treat `null` as
 * "no real route data available" and never substitute a straight-line
 * distance in its place.
 */
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

const ORS_DIRECTIONS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car'
const REQUEST_TIMEOUT_MS = 8000

/**
 * @returns {Promise<{ distanceMeters: number, source: string } | null>}
 */
export async function fetchRoadRouteDistanceMeters({ originLat, originLng, destLat, destLng }) {
  if (![originLat, originLng, destLat, destLng].every(Number.isFinite)) {
    return null
  }

  if (!env.ORS_API_KEY) {
    return null
  }

  try {
    const res = await fetch(ORS_DIRECTIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: env.ORS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        coordinates: [
          [originLng, originLat],
          [destLng, destLat],
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      logger.warn(
        { status: res.status, body: await res.text().catch(() => null) },
        'OpenRouteService route lookup failed'
      )
      return null
    }

    const data = await res.json()
    const meters = data?.routes?.[0]?.summary?.distance

    if (!Number.isFinite(meters) || meters <= 0) {
      logger.warn({ data }, 'OpenRouteService returned no usable route distance')
      return null
    }

    return { distanceMeters: Math.round(meters), source: 'openrouteservice' }
  } catch (err) {
    logger.warn({ err: err.message }, 'OpenRouteService route lookup errored')
    return null
  }
}
