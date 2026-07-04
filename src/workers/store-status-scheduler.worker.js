/**
 * Store Status Scheduler Worker
 *
 * Polls every minute (matching the minute-level granularity of the
 * weekly_hours "HH:MM" schedule) and asks StoreStatusService whether the
 * *effective* open/closed state has flipped since the last tick.
 *
 * Previously isOpen() was only ever evaluated reactively, per-request —
 * nothing proactively noticed a WEEKLY_SCHEDULE boundary crossing (e.g.
 * closing time passing at 9pm with no admin action), so an already-open
 * customer app session kept showing the pre-close state until it happened
 * to refetch, and the transition never showed up anywhere in the admin's
 * activity history. This worker is what makes that automatic: it pushes
 * the same live "instant reflect" signal an admin's own override/hours
 * edit already triggers, and writes a system-attributed audit log row.
 *
 * Runs in every API cluster instance (same pattern as
 * payment-expiry.worker.js / delivery-calendar-generation.worker.js,
 * started from src/server.js) — safe under that duplication because
 * StoreStatusRepository.claimStateTransition() uses a conditional UPDATE
 * as a race guard: only whichever instance's UPDATE actually flips the
 * stored last-known value proceeds to broadcast/log; the other instance's
 * UPDATE affects zero rows and no-ops.
 */
import { logger } from '../config/logger.js'
import { StoreStatusService } from '../modules/store-status/store-status.service.js'

let _intervalHandle = null
const POLL_INTERVAL_MS = 60 * 1000 // 1 minute

export function startStoreStatusSchedulerWorker() {
  if (_intervalHandle) return

  logger.info('Store status scheduler worker started (polling every 1 min)')

  const service = new StoreStatusService()

  _intervalHandle = setInterval(() => {
    service.checkForAutomaticTransition().catch((err) =>
      logger.error({ err: err.message }, 'Store status scheduler poll error')
    )
  }, POLL_INTERVAL_MS)

  // Also run immediately on startup so a transition that happened while
  // the process was down (deploy, restart) is picked up right away
  // instead of waiting up to a full minute.
  service.checkForAutomaticTransition().catch((err) =>
    logger.error({ err: err.message }, 'Store status scheduler initial poll error')
  )
}

export function stopStoreStatusSchedulerWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Store status scheduler worker stopped')
  }
}
