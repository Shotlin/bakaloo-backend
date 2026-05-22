import { query } from '../../config/database.js'

/**
 * Auth repository — all user-related database queries for authentication
 */
export class AuthRepository {
  /**
   * Find user by phone number
   * @param {string} phone
   * @returns {Promise<object|null>}
   */
  async findByPhone(phone) {
    const { rows } = await query(
      `SELECT id, phone, email, name, role, avatar_url, is_active, created_at
       FROM users WHERE phone = $1`,
      [phone]
    )
    return rows[0] || null
  }

  /**
   * Find user by ID
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT id, phone, email, name, role, avatar_url, is_active, created_at
       FROM users WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Create a new user with phone number
   * @param {string} phone
   * @returns {Promise<object>}
   */
  async createUser(phone, role = 'CUSTOMER') {
    const referralCode = this._generateReferralCode()
    const { rows } = await query(
      `INSERT INTO users (phone, role, referral_code)
       VALUES ($1, $2, $3)
       RETURNING id, phone, name, role, is_active, created_at`,
      [phone, role, referralCode]
    )
    return rows[0]
  }

  /**
   * Update a user's role
   * @param {string} userId
   * @param {string} role
   */
  async updateRole(userId, role) {
    await query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`,
      [role, userId]
    )
  }

  /**
   * Ensure a rider_profile row exists for this user.
   * Creates one if missing (with is_approved = false for admin review).
   * @param {string} userId
   */
  async ensureRiderProfile(userId) {
    const { rows } = await query(
      `SELECT id FROM rider_profiles WHERE user_id = $1`,
      [userId]
    )
    if (rows.length === 0) {
      await query(
        `INSERT INTO rider_profiles (user_id, is_approved, is_online)
         VALUES ($1, false, false)`,
        [userId]
      )
    }
  }

  /**
   * Get rider profile for a user
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async getRiderProfile(userId) {
    const { rows } = await query(
      `SELECT * FROM rider_profiles WHERE user_id = $1`,
      [userId]
    )
    return rows[0] || null
  }

  /**
   * Update user's FCM push token
   * @param {string} userId
   * @param {string} fcmToken
   */
  async updateFcmToken(userId, fcmToken) {
    await query(
      `UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2`,
      [fcmToken, userId]
    )
  }

  /**
   * Soft-delete user account (set is_active = false, clear PII)
   * @param {string} userId
   */
  async deleteUser(userId) {
    await query(
      `UPDATE users
       SET is_active = false,
           name = NULL,
           email = NULL,
           avatar_url = NULL,
           fcm_token = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [userId]
    )
  }

  /**
   * Generate a unique 8-char referral code
   */
  _generateReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let code = ''
    for (let i = 0; i < 8; i++) {
      code += chars[Math.floor(Math.random() * chars.length)]
    }
    return code
  }
}
