import admin from 'firebase-admin'
import { env } from './env.js'
import { logger } from './logger.js'

let messaging = null

try {
  if (env.NODE_ENV !== 'test' && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    })
    messaging = admin.messaging()
    logger.info('✅ Firebase Admin initialized')
  } else {
    logger.warn('⚠️  Firebase not configured — push notifications disabled')
  }
} catch (err) {
  logger.warn({ err: err.message }, '⚠️  Firebase initialization failed — push notifications disabled')
}

export { messaging as firebaseMessaging }
export default admin
