import bcrypt from 'bcrypt'
import { logAdminActivity } from '../../../utils/activityLogger.js'

export class AdminAuthService {
  constructor(repository) {
    this.repository = repository
  }

  async login({ email, password }, ip) {
    const admin = await this.repository.findAdminByEmail(email)
    if (!admin) {
      throw { statusCode: 401, message: 'Invalid email or password' }
    }

    if (admin.is_blocked) {
      throw { statusCode: 403, message: `Account blocked: ${admin.block_reason || 'Contact support'}` }
    }

    if (!admin.password_hash) {
      throw { statusCode: 401, message: 'Password not set. Use OTP login and then set a password.' }
    }

    const valid = await bcrypt.compare(password, admin.password_hash)
    if (!valid) {
      logAdminActivity(admin.id, 'Failed login attempt', 'auth', admin.id, null, { email }, ip)
      throw { statusCode: 401, message: 'Invalid email or password' }
    }

    logAdminActivity(admin.id, 'Admin login', 'auth', admin.id, null, { email }, ip)

    return {
      id: admin.id,
      phone: admin.phone,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      role_name: admin.role_name,
      permissions: admin.permissions || [],
    }
  }

  async getProfile(userId) {
    return this.repository.findAdminById(userId)
  }

  async setPassword(userId, newPassword) {
    if (!newPassword || newPassword.length < 8) {
      throw { statusCode: 400, message: 'Password must be at least 8 characters' }
    }
    const hash = await bcrypt.hash(newPassword, 12)
    await this.repository.setPassword(userId, hash)
    logAdminActivity(userId, 'Admin password set/changed', 'auth', userId)
  }
}
