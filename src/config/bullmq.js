import { Queue, Worker } from 'bullmq'
import { env } from './env.js'
import { logger } from './logger.js'

/**
 * BullMQ Redis connection config
 */
const connection = {
  host: env.BULL_REDIS_HOST,
  port: env.BULL_REDIS_PORT,
  maxRetriesPerRequest: null,
}

if (env.BULL_REDIS_PASSWORD) {
  connection.password = env.BULL_REDIS_PASSWORD
}

// ─── QUEUES ──────────────────────────────────────────────

/**
 * Notification queue — push notifications, in-app, SMS
 */
export const notificationQueue = new Queue('notifications', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 24 * 3600 },   // Keep completed for 24h
    removeOnFail: { age: 7 * 24 * 3600 },   // Keep failed for 7 days
  },
})

/**
 * Order processing queue — status updates, assignment, cleanup
 */
export const orderQueue = new Queue('orders', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

/**
 * SMS queue — OTP delivery via 2Factor
 */
export const smsQueue = new Queue('sms', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 3000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 24 * 3600 },
  },
})

/**
 * Theme processing queue — scheduled activation, asset warmup
 */
export const themeQueue = new Queue('themes', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

// ─── WORKERS ─────────────────────────────────────────────

const workers = []

/**
 * Start notification worker
 */
export function startNotificationWorker(processor) {
  const worker = new Worker('notifications', processor, {
    connection,
    concurrency: env.BULL_CONCURRENCY,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Notification job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Notification job failed')
  })

  workers.push(worker)
  logger.info('Notification worker started')
  return worker
}

/**
 * Start order processing worker
 */
export function startOrderWorker(processor) {
  const worker = new Worker('orders', processor, {
    connection,
    concurrency: env.BULL_CONCURRENCY,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Order job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Order job failed')
  })

  workers.push(worker)
  logger.info('Order worker started')
  return worker
}

/**
 * Start SMS worker
 */
export function startSmsWorker(processor) {
  const worker = new Worker('sms', processor, {
    connection,
    concurrency: 2,  // Low concurrency for SMS API rate limits
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'SMS job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'SMS job failed')
  })

  workers.push(worker)
  logger.info('SMS worker started')
  return worker
}

/**
 * Start theme worker
 */
export function startThemeWorker(processor) {
  const worker = new Worker('themes', processor, {
    connection,
    concurrency: 2,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Theme job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Theme job failed')
  })

  workers.push(worker)
  logger.info('Theme worker started')
  return worker
}

/**
 * Close all queues and workers (graceful shutdown)
 */
export async function closeBullMQ() {
  for (const worker of workers) {
    await worker.close()
  }
  await notificationQueue.close()
  await orderQueue.close()
  await smsQueue.close()
  await themeQueue.close()
  logger.info('BullMQ queues and workers closed')
}
