import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

let firebaseApp = null
let _admin = null

/**
 * Initialize Firebase Admin SDK (lazy singleton — safe to call multiple times)
 */
async function getFirebaseApp() {
  if (firebaseApp) return firebaseApp

  if (!env.FCM_ENABLED || !env.FIREBASE_PROJECT_ID) {
    return null
  }

  try {
    const admin = (await import('firebase-admin')).default
    _admin = admin

    // Guard: if default app already exists (e.g. from another import path), reuse it
    if (admin.apps.length > 0) {
      firebaseApp = admin.apps[0]
      logger.info('Firebase Admin SDK reused existing app')
      return firebaseApp
    }

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
 * Send push notification to a single device token.
 * Returns { success, messageId } or { success: false, reason, tokenInvalid }
 */
export async function sendPush(fcmToken, { title, body, imageUrl, deepLink, data = {} }) {
  const app = await getFirebaseApp()
  if (!app) {
    logger.debug({ title }, 'FCM not configured — skipping push notification')
    return { success: false, reason: 'FCM not configured' }
  }

  try {
    const admin = _admin || (await import('firebase-admin')).default
    const stringData = Object.fromEntries(
      Object.entries({
        ...data,
        ...(deepLink ? { deepLink } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      })
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)])
    )

    const message = {
      token: fcmToken,
      notification: {
        title,
        body,
        ...(imageUrl && isValidHttpsUrl(imageUrl) ? { imageUrl } : {}),
      },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'bakaloo_notifications',
          imageUrl: imageUrl && isValidHttpsUrl(imageUrl) ? imageUrl : undefined,
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
        fcmOptions: imageUrl && isValidHttpsUrl(imageUrl)
          ? { imageUrl }
          : undefined,
      },
    }

    const result = await admin.messaging().send(message)
    logger.info({ messageId: result, title }, 'Push notification sent')
    return { success: true, messageId: result }
  } catch (err) {
    const tokenInvalid = isTokenInvalidError(err)
    logger.error({ err: err.message, title, tokenInvalid }, 'Push notification failed')
    return { success: false, reason: err.message, tokenInvalid }
  }
}

// FCM hard caps a single sendEach()/sendEachForMulticast() call at 500
// messages — anything larger must be split into chunks and sent as
// separate calls (see FCM_BATCH_CHUNK_SIZE usage below).
const FCM_BATCH_CHUNK_SIZE = 500
// How many chunks to have in flight at once. Keeps large campaigns
// (thousands of tokens) fast without firing hundreds of concurrent
// requests at the FCM API.
const FCM_BATCH_CONCURRENCY = 5

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Send push to multiple tokens with partial failure handling.
 * Deactivates invalid tokens in bulk.
 *
 * Internally chunks into batches of FCM_BATCH_CHUNK_SIZE (FCM's hard
 * per-call limit) and sends the chunks with bounded concurrency, then
 * merges the results back into a single summary.
 */
export async function sendPushBatch(fcmTokens, { title, body, imageUrl, deepLink, data = {} }) {
  if (!fcmTokens?.length) return { success: false, reason: 'No tokens', sent: 0, failed: 0 }

  const app = await getFirebaseApp()
  if (!app) {
    logger.debug({ title }, 'FCM not configured — skipping batch push')
    return { success: false, reason: 'FCM not configured', sent: 0, failed: 0 }
  }

  const admin = _admin || (await import('firebase-admin')).default
  const stringData = Object.fromEntries(
    Object.entries({
      ...data,
      ...(deepLink ? { deepLink } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    })
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, String(v)])
  )

  const buildMessage = (token) => ({
    token,
    notification: {
      title,
      body,
      ...(imageUrl && isValidHttpsUrl(imageUrl) ? { imageUrl } : {}),
    },
    data: stringData,
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'bakaloo_notifications',
        imageUrl: imageUrl && isValidHttpsUrl(imageUrl) ? imageUrl : undefined,
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
    },
    apns: {
      payload: { aps: { sound: 'default', badge: 1 } },
      fcmOptions: imageUrl && isValidHttpsUrl(imageUrl)
        ? { imageUrl }
        : undefined,
    },
  })

  const tokenChunks = chunk(fcmTokens, FCM_BATCH_CHUNK_SIZE)
  let sent = 0
  let failed = 0
  const invalidTokens = []
  const chunkErrors = []

  // Send chunks with bounded concurrency (FCM_BATCH_CONCURRENCY at a time)
  // rather than all at once, to stay well under FCM's rate limits on
  // very large campaigns.
  for (let i = 0; i < tokenChunks.length; i += FCM_BATCH_CONCURRENCY) {
    const group = tokenChunks.slice(i, i + FCM_BATCH_CONCURRENCY)
    await Promise.all(
      group.map(async (tokens) => {
        try {
          const result = await admin.messaging().sendEach(tokens.map(buildMessage))
          sent += result.successCount
          failed += result.failureCount
          result.responses.forEach((r, idx) => {
            if (!r.success && isTokenInvalidError(r.error)) {
              invalidTokens.push(tokens[idx])
            }
          })
        } catch (err) {
          logger.error({ err: err.message, title }, 'Batch push chunk failed')
          failed += tokens.length
          chunkErrors.push(err.message)
        }
      })
    )
  }

  logger.info({ title, sent, failed, chunks: tokenChunks.length }, 'Batch push complete')

  // Only a total failure (every chunk errored, nothing delivered) is
  // reported as success: false — a campaign with some successful chunks
  // should still be marked SENT with a partial failure count.
  const success = sent > 0 || chunkErrors.length === 0

  return {
    success,
    sent,
    failed,
    invalidTokens,
    ...(chunkErrors.length > 0 ? { reason: chunkErrors[0] } : {}),
  }
}

// Export a getter for messaging instance (used by firebase.js re-export)
export const firebaseMessaging = null // lazy — use sendPush/sendPushBatch

function isValidHttpsUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

function isTokenInvalidError(err) {
  if (!err) return false
  const code = err.code || err.errorInfo?.code || ''
  // Only deactivate on definitive "token no longer valid" errors
  // Do NOT deactivate on quota/rate-limit/server errors
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code.includes('registration-token-not-registered')
  )
}
