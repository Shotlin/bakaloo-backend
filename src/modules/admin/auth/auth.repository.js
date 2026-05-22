import { query } from '../../../config/database.js'

export class AdminAuthRepository {
  async findAdminByEmail(email) {
    const { rows } = await query(
      `SELECT u.id, u.phone, u.email, u.name, u.role, u.password_hash, u.is_blocked, u.block_reason,
              COALESCE(r.name, 'No Role') AS role_name,
              COALESCE(r.permissions, '[]'::jsonb) AS permissions
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.email = $1 AND u.role = 'ADMIN'`,
      [email]
    )
    return rows[0] || null
  }

  async findAdminById(id) {
    const { rows } = await query(
      `SELECT u.id, u.phone, u.email, u.name, u.role,
              COALESCE(r.name, 'No Role') AS role_name,
              COALESCE(r.permissions, '[]'::jsonb) AS permissions
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1 AND u.role = 'ADMIN' AND (u.is_blocked = false OR u.is_blocked IS NULL)`,
      [id]
    )
    return rows[0] || null
  }

  async setPassword(userId, passwordHash) {
    await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [passwordHash, userId]
    )
  }
}
