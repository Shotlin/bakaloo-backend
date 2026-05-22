import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

let firebaseApp = null

/**
 * Initialize Firebase Admin SDK (lazy — only when first needed)
 */
async function getFirebaseApp() {
  if (firebaseApp) return firebaseApp

  if (!env.FCM_ENABLED || !env.FIREBASE_PROJECT_ID) {
    return null
  }

  try {
    const admin = (await import('firebase-admin')).default

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
      }),
    })

    logger.info('Firebase Admin SDK initialized')
    return firebaseApp
  } catch (err) {
    logger.error({ err }, 'Firebase Admin SDK init failed')
    return null
  }
}

/**
 * Send push notification to a single device
 * @param {string} fcmToken - Device FCM token
 * @param {{ title: string, body: string, data?: object }} payload
 */
export async function sendPush(fcmToken, { title, body, data = {} }) {
  const app = await getFirebaseApp()
  if (!app) {
    logger.debug({ title }, 'FCM not configured — skipping push notification')
    return { success: false, reason: 'FCM not configured' }
  }

  try {
    const admin = (await import('firebase-admin')).default
    const message = {
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'bakaloo_notifications' },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    }

    const result = await admin.messaging().send(message)
    logger.info({ messageId: result, title }, 'Push notification sent')
    return { success: true, messageId: result }
  } catch (err) {
    logger.error({ err, title }, 'Push notification failed')
    return { success: false, reason: err.message }
  }
}

/**
 * Send push notification to multiple devices
 * @param {string[]} fcmTokens - Array of device tokens
 * @param {{ title: string, body: string, data?: object }} payload
 */
export async function sendPushBatch(fcmTokens, { title, body, data = {} }) {
  if (!fcmTokens?.length) return { success: false, reason: 'No tokens' }

  const app = await getFirebaseApp()
  if (!app) {
    logger.debug({ title, count: fcmTokens.length }, 'FCM not configured — skipping batch push')
    return { success: false, reason: 'FCM not configured' }
  }

  try {
    const admin = (await import('firebase-admin')).default
    const messages = fcmTokens.map((token) => ({
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
    }))

    const result = await admin.messaging().sendEach(messages)
    logger.info(
      { title, sent: result.successCount, failed: result.failureCount },
      'Batch push complete'
    )
    return { success: true, sent: result.successCount, failed: result.failureCount }
  } catch (err) {
    logger.error({ err, title }, 'Batch push failed')
    return { success: false, reason: err.message }
  }
}
