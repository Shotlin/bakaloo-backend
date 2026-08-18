import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { requestContext } from '../plugins/requestContext.plugin.js'

/**
 * Log an admin action to admin_activity_log (fire-and-forget)
 * Never throws — errors are silently logged
 *
 * @param {string} adminId - UUID of admin user
 * @param {string} action - Human-readable action description
 * @param {string} entityType - 'product', 'order', 'user', 'rider', 'banner', etc.
 * @param {string|null} entityId - UUID of the entity (nullable)
 * @param {object|null} oldValue - Previous value (JSONB)
 * @param {object|null} newValue - New value (JSONB)
 * @param {string|null} ipAddress - Client IP address. Falls back to the current
 *   request's IP (via requestContext) when omitted, so existing call sites
 *   that already pass it explicitly are unaffected.
 * @param {string|null} userAgent - Client User-Agent header. Falls back to the
 *   current request's User-Agent (via requestContext) when omitted — none of
 *   the ~77 existing call sites need to be touched to start capturing it.
 */
export function logAdminActivity(adminId, action, entityType, entityId = null, oldValue = null, newValue = null, ipAddress = null, userAgent = null) {
  const ctx = requestContext.getStore()
  const resolvedIp = ipAddress ?? ctx?.ip ?? null
  const resolvedUserAgent = userAgent ?? ctx?.userAgent ?? null

  setImmediate(async () => {
    try {
      await query(
        `INSERT INTO admin_activity_log (admin_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          adminId,
          action,
          entityType,
          entityId,
          oldValue ? JSON.stringify(oldValue) : null,
          newValue ? JSON.stringify(newValue) : null,
          resolvedIp,
          resolvedUserAgent,
        ]
      )
    } catch (err) {
      logger.error({ err, adminId, action, entityType }, 'Failed to log admin activity')
    }
  })
}
