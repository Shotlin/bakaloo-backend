// One-off backfill: calculates and permanently stores the real road-route
// distance (store -> customer, via OpenRouteService) for existing orders
// that don't have one yet. Run manually — not wired to server startup or
// any cron — via:
//
//   node scripts/backfill_order_route_distance.mjs [--days=30] [--limit=5] [--dry-run]
//
// Idempotent: only touches orders where route_distance_meters IS NULL, so
// re-running (e.g. after a partial run got interrupted) just picks up
// where it left off instead of re-querying orders already done.
//
// Throttled to stay comfortably under OpenRouteService's free-tier limit
// (40 requests/minute) — one request every 2 seconds, ~1,800/hour max.
import 'dotenv/config'
import { query, closePool } from '../src/config/database.js'
import { fetchRoadRouteDistanceMeters } from '../src/utils/routing.js'

const DAYS = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 30)
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0) || null
const DRY_RUN = process.argv.includes('--dry-run')
const DELAY_MS = 2000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  if (!process.env.ORS_API_KEY) {
    console.error('ORS_API_KEY is not set — nothing to backfill. Set it in .env and re-run.')
    process.exit(1)
  }

  const { rows } = await query(
    `SELECT o.id, o.order_number, o.delivery_address, s.lat AS shop_lat, s.lng AS shop_lng
     FROM orders o
     JOIN shops s ON s.id = o.shop_id
     WHERE o.route_distance_meters IS NULL
       AND o.created_at >= NOW() - ($1 * INTERVAL '1 day')
       AND s.lat IS NOT NULL AND s.lng IS NOT NULL
     ORDER BY o.created_at DESC
     ${LIMIT ? `LIMIT ${LIMIT}` : ''}`,
    [DAYS]
  )

  console.log(
    `Found ${rows.length} orders from the last ${DAYS} days missing a road-route distance` +
      (LIMIT ? ` (capped at --limit=${LIMIT}).` : '.')
  )
  if (DRY_RUN) {
    console.log('--dry-run: not calling the routing API or writing anything.')
  }

  let done = 0
  let skippedNoCoords = 0
  let failed = 0

  for (const row of rows) {
    const addr = typeof row.delivery_address === 'string'
      ? JSON.parse(row.delivery_address)
      : row.delivery_address || {}
    const destLat = Number(addr.lat ?? addr.latitude)
    const destLng = Number(addr.lng ?? addr.longitude)
    const originLat = Number(row.shop_lat)
    const originLng = Number(row.shop_lng)

    if (![destLat, destLng, originLat, originLng].every(Number.isFinite)) {
      skippedNoCoords++
      continue
    }

    if (DRY_RUN) {
      console.log(`[dry-run] would look up ${row.order_number}`)
      continue
    }

    const result = await fetchRoadRouteDistanceMeters({ originLat, originLng, destLat, destLng })
    if (result) {
      await query(
        `UPDATE orders SET route_distance_meters = $1, route_source = $2, route_calculated_at = NOW() WHERE id = $3`,
        [result.distanceMeters, result.source, row.id]
      )
      done++
      console.log(`✓ ${row.order_number}: ${(result.distanceMeters / 1000).toFixed(1)} km`)
    } else {
      failed++
      console.log(`✗ ${row.order_number}: routing API returned no result`)
    }

    await sleep(DELAY_MS)
  }

  console.log(
    `\nDone. ${done} stored, ${failed} failed (no route found), ${skippedNoCoords} skipped (missing coordinates).`
  )
  await closePool()
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
