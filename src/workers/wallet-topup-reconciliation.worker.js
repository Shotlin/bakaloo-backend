/**
 * Wallet Top-up Reconciliation Worker
 *
 * Safety net for wallet top-ups that get stuck at status='PENDING' forever.
 * The normal flow (WalletService.verifyTopUp) relies entirely on the app
 * calling us back right after Razorpay checkout succeeds — a single
 * client-side call with no retry. If the app is killed, loses network, or
 * a UPI app-switch doesn't cleanly return control before that call fires,
 * Razorpay has already captured the customer's money but our wallet never
 * credits it, and nothing else catches the gap. The Razorpay webhook
 * (payment.captured) can also close this, but only once it's registered
 * in the Razorpay Dashboard — this worker doesn't depend on that at all,
 * since it polls Razorpay's own order/payments API directly.
 *
 * Every run: finds PENDING top-ups older than GRACE_PERIOD_MINUTES (so a
 * customer mid-payment is never touched), checks each against Razorpay:
 *   - payment actually captured  -> credit the wallet (completeVerifiedTopUp)
 *   - no payment after ABANDON_AFTER_HOURS -> mark FAILED (cleans it out of
 *     admin views; the customer genuinely never paid, e.g. cancelled checkout)
 *   - otherwise -> leave as PENDING, check again next run
 */
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { razorpay } from '../config/razorpay.js'
import { WalletService } from '../modules/wallet/wallet.service.js'
import { WalletRepository } from '../modules/wallet/wallet.repository.js'

let _intervalHandle = null
const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const GRACE_PERIOD_MINUTES = 10
const ABANDON_AFTER_HOURS = 24
const BATCH_LIMIT = 25

const walletRepo = new WalletRepository()
const walletService = new WalletService(walletRepo)

export function startWalletTopupReconciliationWorker() {
  if (_intervalHandle) return

  logger.info('Wallet top-up reconciliation worker started (polling every 5 min)')

  _intervalHandle = setInterval(async () => {
    try {
      await _reconcilePendingTopUps()
    } catch (err) {
      logger.error({ err: err.message }, 'Wallet top-up reconciliation worker poll error')
    }
  }, POLL_INTERVAL_MS)

  _reconcilePendingTopUps().catch(err =>
    logger.error({ err: err.message }, 'Wallet top-up reconciliation worker initial poll error')
  )
}

export function stopWalletTopupReconciliationWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Wallet top-up reconciliation worker stopped')
  }
}

async function _reconcilePendingTopUps() {
  if (!razorpay) return

  const { rows } = await query(
    `SELECT id, reference_id, created_at
     FROM wallet_transactions
     WHERE status = 'PENDING'
       AND type = 'CREDIT'
       AND reference_id IS NOT NULL
       AND created_at < NOW() - INTERVAL '${GRACE_PERIOD_MINUTES} minutes'
     ORDER BY created_at ASC
     LIMIT ${BATCH_LIMIT}`
  )

  if (rows.length === 0) return

  logger.info({ count: rows.length }, 'Wallet top-up reconciliation: checking pending top-ups against Razorpay')

  for (const row of rows) {
    try {
      const payments = await razorpay.orders.fetchPayments(row.reference_id)
      const captured = (payments.items || []).find((p) => p.status === 'captured')

      if (captured) {
        const result = await walletService.completeVerifiedTopUp(row.reference_id)
        if (result.success && !result.skipped) {
          logger.info(
            { orderId: row.reference_id, paymentId: captured.id },
            'Wallet top-up reconciliation: payment was captured, wallet credited'
          )
        }
        continue
      }

      const ageHours = (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60)
      if (ageHours >= ABANDON_AFTER_HOURS) {
        const failed = await walletRepo.markStalePendingAsFailed(row.reference_id)
        if (failed) {
          logger.info({ orderId: row.reference_id }, 'Wallet top-up reconciliation: no payment ever captured, marked FAILED')
        }
      }
    } catch (err) {
      logger.warn({ err: err.message, orderId: row.reference_id }, 'Wallet top-up reconciliation: Razorpay check failed for this order')
    }
  }
}
