/**
 * Delivery Calendar Generation Worker
 *
 * Keeps the materialized delivery calendar topped up ~30 days ahead of the
 * admin's weekly template, so the customer-facing slot picker never runs
 * dry without an admin having to remember to click "Generate". Runs once
 * immediately on boot (self-healing after a fresh migration/deploy) and
 * then every 6 hours — cheap and idempotent (`generateForwardDays` skips
 * any date that already exists), so overlapping ticks across PM2 cluster
 * workers are harmless.
 */
import { getDeliveryCalendarService } from '../modules/delivery-calendar/delivery-calendar.routes.js'
import { logger } from '../config/logger.js'

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
const FORWARD_DAYS = 30

let _intervalHandle = null

export function startDeliveryCalendarGenerationWorker() {
  if (_intervalHandle) return

  logger.info('Delivery calendar generation worker started (every 6h)')

  _intervalHandle = setInterval(() => {
    _generate().catch((err) =>
      logger.error({ err: err.message }, 'Delivery calendar generation tick error')
    )
  }, POLL_INTERVAL_MS)

  _generate().catch((err) =>
    logger.error({ err: err.message }, 'Delivery calendar generation initial run error')
  )
}

export function stopDeliveryCalendarGenerationWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Delivery calendar generation worker stopped')
  }
}

async function _generate() {
  const service = getDeliveryCalendarService()
  const result = await service.generateForwardDays(FORWARD_DAYS)
  if (result.generated > 0) {
    logger.info({ generated: result.generated }, 'Delivery calendar topped up')
  }
}
