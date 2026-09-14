import { AdminNavButtonsRepository } from './nav-buttons.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'

const repo = new AdminNavButtonsRepository()

export class AdminNavButtonsService {
  async list() {
    return repo.findAll()
  }

  async getById(id) {
    return repo.findById(id)
  }

  async create(data, adminId, ip) {
    const btn = await repo.create(data, adminId)
    logAdminActivity(adminId, 'CREATE_NAV_BUTTON', 'nav_button', btn.id, null, null, ip)
    return btn
  }

  async update(id, data, adminId, ip) {
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
}
