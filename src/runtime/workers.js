import { logger } from '../config/logger.js'
import {
  orderQueue,
  closeBullMQ,
  startNotificationWorker,
  startOrderWorker,
  startSmsWorker,
  startThemeWorker,
} from '../config/bullmq.js'

export async function startWorkerRuntime() {
  const {
    processNotificationJob,
    processOrderJob,
    processSmsJob,
    processThemeJob,
    clearLegacyAssignmentTimeoutJobs,
  } = await import('../workers/processors.js')

  startNotificationWorker(processNotificationJob)
  startOrderWorker(processOrderJob)
  startSmsWorker(processSmsJob)
  startThemeWorker(processThemeJob)

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
