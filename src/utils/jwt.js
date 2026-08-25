import jwt from 'jsonwebtoken'
import ms from 'ms'
import { env } from '../config/env.js'

/**
 * Sign an access token (short-lived)
 * @param {object} payload - { id, phone, role, ... }
 * @param {object} [options] - Optional override (e.g. { expiresIn })
 * @returns {string} JWT
 */
export function signAccessToken(payload, options = {}) {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: options.expiresIn || env.JWT_ACCESS_EXPIRY,
  })
}

/**
 * Sign a refresh token (long-lived)
 * @param {object} payload - { id, phone, role }
 * @returns {string} JWT
 */
export function signRefreshToken(payload) {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRY,
  })
}

/**
 * Seconds a refresh token session should live in Redis — derived from the
 * same JWT_REFRESH_EXPIRY that signs the token's own `exp` claim, so the
 * Redis-side session record and the JWT's signature never disagree about
 * when the session actually ends (they used to: three call sites had this
 * hardcoded to a literal 7 days regardless of what JWT_REFRESH_EXPIRY said).
 * @returns {number}
 */
export function refreshTokenTtlSeconds() {
  return Math.floor(ms(env.JWT_REFRESH_EXPIRY) / 1000)
}

/**
 * Verify a token with the given secret
 * @param {string} token
 * @param {string} secret
 * @returns {object} Decoded payload
 * @throws {Error} If invalid or expired
 */
export function verifyToken(token, secret) {
  return jwt.verify(token, secret)
}

/**
 * Generate both access + refresh token pair
 * @param {object} payload - { id, phone, role }
 * @returns {{ accessToken: string, refreshToken: string }}
 */
export function generateTokenPair(payload) {
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  }
}
