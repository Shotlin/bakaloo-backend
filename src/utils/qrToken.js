import crypto from 'node:crypto'
import { env } from '../config/env.js'

// Same HMAC-SHA256-over-a-joined-string pattern already used for Razorpay
// payment/webhook signature verification (payments.service.js, wallet
// wallet.service.js) — reused here rather than introducing a second
// signing convention. Falls back to JWT_ACCESS_SECRET so this works out of
// the box without a new required env var; set QR_SIGNING_SECRET separately
// if you want QR tokens to survive a JWT-secret rotation independently.
const SIGNING_SECRET = env.QR_SIGNING_SECRET || env.JWT_ACCESS_SECRET

export const QR_TOKEN_VERSION = 1

/** Random 32-byte hex token — the opaque credential stored in order_pickup_tokens.token. */
export function generatePickupToken() {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Signs {orderId, assignmentId, token, version} so a scanned QR payload can
 * be verified without a DB round-trip for tamper-detection (the DB lookup
 * still happens separately, to check revocation/expiry/consumption state —
 * the signature alone only proves the payload wasn't altered in transit).
 */
export function signPickupPayload({ orderId, assignmentId, token, version = QR_TOKEN_VERSION }) {
  return crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`${orderId}|${assignmentId}|${token}|${version}`)
    .digest('hex')
}

export function verifyPickupSignature({ orderId, assignmentId, token, version = QR_TOKEN_VERSION, signature }) {
  const expected = signPickupPayload({ orderId, assignmentId, token, version })
  if (expected.length !== String(signature || '').length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}
