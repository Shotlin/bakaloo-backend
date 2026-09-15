import { AdminNavButtonsRepository } from './nav-buttons.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'

const repo = new AdminNavButtonsRepository()

/**
 * Mirrors migration 136's chk_nav_buttons_icon_source constraint, checked
 * here first so a bad request gets a clear 400 with a real message
 * instead of a raw Postgres constraint-violation error.
 */
function validateIconFields(data) {
  const iconType = data.iconType || 'PRESET'
  if (iconType === 'PRESET' && !data.iconKey) {
    return 'iconKey is required when iconType is PRESET'
  }
  if (iconType === 'CUSTOM' && !data.customIconActiveUrl) {
    return 'customIconActiveUrl is required when iconType is CUSTOM'
  }
  return null
}

export class AdminNavButtonsService {
  async list() {
    return repo.findAll()
  }

  async getById(id) {
    return repo.findById(id)
  }

  async create(data, adminId, ip) {
    const validationError = validateIconFields(data)
    if (validationError) {
      throw Object.assign(new Error(validationError), { statusCode: 400 })
    }
    const btn = await repo.create(data, adminId)
    logAdminActivity(adminId, 'CREATE_NAV_BUTTON', 'nav_button', btn.id, null, null, ip)
    return btn
  }

  async update(id, data, adminId, ip) {
    // A partial update (e.g. just toggling isActive) shouldn't have to
    // resend the whole icon config — only re-validate when the update
    // actually touches icon fields, against what would be true AFTER
    // merging this patch onto the existing row.
    const touchesIconFields =
      data.iconType !== undefined || data.iconKey !== undefined ||
      data.customIconActiveUrl !== undefined
    if (touchesIconFields) {
      const existing = await repo.findById(id)
      if (!existing) return null
      const merged = {
        iconType: data.iconType !== undefined ? data.iconType : existing.icon_type,
        iconKey: data.iconKey !== undefined ? data.iconKey : existing.icon_key,
        customIconActiveUrl: data.customIconActiveUrl !== undefined
          ? data.customIconActiveUrl
          : existing.custom_icon_active_url,
      }
      const validationError = validateIconFields(merged)
      if (validationError) {
        throw Object.assign(new Error(validationError), { statusCode: 400 })
      }
    }
    const btn = await repo.update(id, data)
    if (btn) logAdminActivity(adminId, 'UPDATE_NAV_BUTTON', 'nav_button', id, null, null, ip)
    return btn
  }

  async remove(id, adminId, ip) {
    const ok = await repo.remove(id)
    if (ok) logAdminActivity(adminId, 'DELETE_NAV_BUTTON', 'nav_button', id, null, null, ip)
    return ok
  }

  async reorder(orderedIds, adminId, ip) {
    await repo.reorder(orderedIds)
    logAdminActivity(adminId, 'REORDER_NAV_BUTTONS', 'nav_button', null, null, { count: orderedIds.length }, ip)
    return true
  }

  async getActiveForViewer(audience = 'B2C', userId = null) {
    return repo.findActiveForViewer(audience, userId)
  }

  async getAllActiveForViewer(placement, audience = 'B2C', userId = null) {
    return repo.findAllActiveForViewer(placement, audience, userId)
  }
}
