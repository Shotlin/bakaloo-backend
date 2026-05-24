import { logger } from '../config/logger.js'
import {
  orderQueue,
  settlementQueue,
  payoutQueue,
  closeBullMQ,
  startNotificationWorker,
  startOrderWorker,
  startSmsWorker,
  startThemeWorker,
  startAllocationWorker,
  startSettlementWorker,
  startPayoutWorker,
  startScheduledOrderWorker,
  startStockNotificationsWorker,
} from '../config/bullmq.js'

export async function startWorkerRuntime() {
  const {
    processNotificationJob,
    processOrderJob,
    processSmsJob,
    processThemeJob,
    clearLegacyAssignmentTimeoutJobs,
  } = await import('../workers/processors.js')

  const { createAllocationProcessor } = await import(
    '../workers/allocation.worker.js'
  )

  const { createSettlementProcessor, scheduleSettlementCron } = await import(
    '../workers/settlement.worker.js'
  )

  const { createPayoutProcessor, schedulePayoutCron } = await import(
    '../workers/payout.worker.js'
  )

  const { createScheduledOrderProcessor } = await import(
    '../workers/scheduled-orders.worker.js'
  )

  const { createStockNotificationsProcessor } = await import(
    '../workers/stock-notifications.worker.js'
  )

  startNotificationWorker(processNotificationJob)
  startOrderWorker(processOrderJob)
  startSmsWorker(processSmsJob)
  startThemeWorker(processThemeJob)
  startAllocationWorker(createAllocationProcessor())
  startSettlementWorker(
    createSettlementProcessor({ queue: settlementQueue })
  )
  startPayoutWorker(createPayoutProcessor({ queue: payoutQueue }))
  // Scheduled-orders worker (task 10.3) — fires customer scheduled orders
  // at their scheduled_for time, places real orders, marks FAILED on
  // stock issues, and creates the next recurrence row when applicable.
  startScheduledOrderWorker(createScheduledOrderProcessor())
  // Stock-notifications worker (task 13.2) — fans out restock push +
  // in-app notifications to every customer who wishlisted a product
  // when its Shop_Product transitions from stock 0 → positive
  // (Requirements 3.4, 11.6).
  startStockNotificationsWorker(createStockNotificationsProcessor())

  try {
    await scheduleSettlementCron(settlementQueue)
  } catch (err) {
    logger.warn(
      { err: err.message },
      'Settlement daily cron registration failed'
    )
  }

  try {
    await schedulePayoutCron(payoutQueue)
  } catch (err) {
    logger.warn(
      { err: err.message },
      'Payout weekly cron registration failed'
    )
  }

  try {
    const removedTimeoutJobs = await clearLegacyAssignmentTimeoutJobs()
    if (removedTimeoutJobs > 0) {
      logger.info(
        { removedTimeoutJobs },
        'Cleared legacy assignment timeout jobs'
      )
    }
  } catch (err) {
    logger.warn(
      { err: err.message },
      'Legacy assignment timeout jobs were not cleared'
    )
  }

  try {
    await orderQueue.add(
      'auto-assign-backlog',
      { type: 'auto-assign-backlog', limit: 500 },
      {
        jobId: 'auto-assign-backlog-startup',
        removeOnComplete: true,
        removeOnFail: true,
      }
    )
  } catch (err) {
    logger.warn(
      { err: err.message },
      'Startup backlog auto-assign job was not queued'
    )
  }

  logger.info('BullMQ workers started')
}

export async function closeWorkerRuntime() {
  await closeBullMQ()
  logger.info('BullMQ queues and workers closed')
}
