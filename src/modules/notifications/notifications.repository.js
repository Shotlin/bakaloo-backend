import { query, getClient } from '../../config/database.js'

/**
 * Notifications repository — database access for notifications
 */
export class NotificationsRepository {
  async getNotifications(userId, { offset, limit, unreadOnly }) {
    let sql = 'SELECT * FROM notifications WHERE user_id = $1'
    const params = [userId]

    if (unreadOnly) {
      sql += ' AND is_read = false'
    }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*)')
    const countResult = await query(countSql, params)
    const total = parseInt(countResult.rows[0].count)

    params.push(limit, offset)
    sql += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3'

    const result = await query(sql, params)

    const unreadCount = await query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [userId]
    )

    return {
      notifications: result.rows,
      unreadCount: parseInt(unreadCount.rows[0].count),
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async getNotificationById(notificationId) {
    const { rows } = await query(
      'SELECT id, user_id FROM notifications WHERE id = $1',
      [notificationId]
    )
    return rows[0]
  }

  async markAsRead(notificationId) {
    await query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = $1',
      [notificationId]
    )
  }

  async markAllAsRead(userId) {
    await query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = $1 AND is_read = false',
      [userId]
    )
  }

  async deleteNotification(notificationId) {
    await query('DELETE FROM notifications WHERE id = $1', [notificationId])
  }

  async getPreferences(userId) {
    const { rows } = await query(
      'SELECT notification_preferences FROM users WHERE id = $1',
      [userId]
    )

    const prefs = rows[0]?.notification_preferences || {}

    return {
      orderUpdates: prefs.orderUpdates !== false,
      promotions: prefs.promotions !== false,
      newProducts: prefs.newProducts !== false,
      deliveryUpdates: prefs.deliveryUpdates !== false,
      priceDrops: prefs.priceDrops !== false,
    }
  }

  async updatePreferences(userId, preferences) {
    const { rows } = await query(
      'UPDATE users SET notification_preferences = $1 WHERE id = $2 RETURNING notification_preferences',
      [JSON.stringify(preferences), userId]
    )
    return rows[0].notification_preferences
  }

  async registerToken(userId, token, platform) {
    const { rows: existing } = await query(
      'SELECT id FROM fcm_tokens WHERE token = $1',
      [token]
    )

    if (existing.length > 0) {
      await query(
        'UPDATE fcm_tokens SET user_id = $1, platform = $2, updated_at = NOW() WHERE token = $3',
        [userId, platform, token]
      )
    } else {
      await query(
        'INSERT INTO fcm_tokens (user_id, token, platform) VALUES ($1, $2, $3)',
        [userId, token, platform]
      )
    }
  }

  async getFcmTokens(userId) {
    const { rows } = await query(
      'SELECT token, platform FROM fcm_tokens WHERE user_id = $1',
      [userId]
    )
    return rows
  }

  async createNotification(userId, { title, body, type, data }) {
    const { rows } = await query(
      `INSERT INTO notifications (user_id, title, body, type, data)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, body, type, data, is_read, created_at`,
      [userId, title, body, type, JSON.stringify(data || {})]
    )
    return rows[0]
  }
}
