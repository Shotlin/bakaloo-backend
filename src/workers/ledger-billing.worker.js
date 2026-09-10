// B2B Ledger — Ledger_Billing_Worker. Processes BullMQ `ledger-billing`
// queue jobs.
//
// Job types:
//   - `daily-run` — Cron-triggered (03:00 UTC daily, deliberately off the
//                   settlement/payout cron slots at 02:00). Delegates the
//                   full open-cycle + overdue-sweep logic to
//                   LedgerService#runDailyBillingCycle — see that method's
//                   docstring for the idempotency argument (unique
//                   (account, period_start) constraint + per-row
//                   lock-and-recheck on the overdue sweep).
//
// Concurrency 1 (mirrors payout.worker.js): billing-cycle writes and the
// account suspend/reactivate transitions they can trigger are serialized
// so a retry can never double-open a cycle or double-suspend an account
// mid-write. The service itself already reads as idempotent even under a
// concurrent re-run, but serializing removes the need to reason about it.
//
// Thin dispatcher — all business logic lives in LedgerService so it can
// be unit-tested without BullMQ.

import { logger } from '../config/logger.js'
import { LedgerService } from '../modules/ledger/ledger.service.js'

/**
 * @param {object} [deps]
 * @param {LedgerService} [deps.ledgerService]
 * @returns {(job: import('bullmq').Job) => Promise<object>}
 */
export function createLedgerBillingProcessor(deps = {}) {
  const service = deps.ledgerService || new LedgerService()

  return async function processLedgerBillingJob(job) {
    const type = job?.data?.type || job?.name

    if (type === 'daily-run') {
      return handleDailyRun(job, { service })
    }

    logger.warn(
      { jobId: job?.id, type, action: 'ledger_billing_unknown_job_type' },
      'Unknown ledger-billing job type'
    )
    return { ignored: true }
  }
}

async function handleDailyRun(job, { service }) {
  const asOf = job?.data?.asOf ? new Date(job.data.asOf) : new Date()
  const summary = await service.runDailyBillingCycle(asOf)
  return { type: 'daily-run', ...summary }
}

/**
 * Register the daily ledger-billing cron on a queue.
 *
 * Pattern: `0 3 * * *` → 03:00 UTC daily — one hour after the
 * settlement/payout 02:00 slots so none of these financial jobs compete
 * for DB connections at the same moment. Stable jobId keeps successive
 * cron registrations idempotent across restarts.
 *
 * @param {import('bullmq').Queue} queue
 * @returns {Promise<void>}
 */
export async function scheduleLedgerBillingCron(queue) {
  if (!queue) return
  await queue.add(
    'daily-run',
    { type: 'daily-run' },
    {
      repeat: { pattern: '0 3 * * *', tz: 'UTC' },
      jobId: 'ledger-billing-daily-cron',
      removeOnComplete: true,
      removeOnFail: false,
    }
  )
  logger.info(
    { action: 'ledger_billing_cron_registered', pattern: '0 3 * * * (UTC)' },
    'Ledger-billing daily cron registered'
  )
}
