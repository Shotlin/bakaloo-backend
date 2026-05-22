import { AdminRidersRepository } from './riders.repository.js'
import { orderQueue } from '../../../config/bullmq.js'
import { logger } from '../../../config/logger.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'

const repo = new AdminRidersRepository()

export class AdminRidersService {
  async list({ page = 1, limit = 20, search, status, sortBy, sortOrder }) {
    const offset = (page - 1) * limit
    return repo.findAll({ offset, limit, search, status, sortBy, sortOrder })
  }

  async getDetail(riderId) {
    return repo.findById(riderId)
  }

  async getEarnings(riderId, { startDate, endDate }) {
    return repo.getEarnings(riderId, { startDate, endDate })
  }

  async getPayouts(riderId) {
    return repo.getPayouts(riderId)
  }

  async createPayout(riderId, { amount, method, reference }, adminId, ip) {
    const payout = await repo.createPayout(riderId, amount, method, reference, adminId)
    logAdminActivity(adminId, 'CREATE_PAYOUT', 'rider', riderId, null, { amount, method }, ip)
    return payout
  }

  async toggleSuspend(riderId, suspended, adminId, ip) {
    const user = await repo.toggleSuspend(riderId, suspended)
    logAdminActivity(adminId, suspended ? 'SUSPEND_RIDER' : 'UNSUSPEND_RIDER', 'rider', riderId, null, null, ip)
    return user
  }

  async updateCommission(riderId, rate, adminId, ip) {
    const profile = await repo.updateCommission(riderId, rate)
    logAdminActivity(adminId, 'UPDATE_COMMISSION', 'rider', riderId, null, { rate }, ip)
    return profile
  }

  async approveRider(riderId, is_approved, adminId, ip) {
    const profile = await repo.approveRider(riderId, is_approved)
    logAdminActivity(adminId, is_approved ? 'APPROVE_RIDER' : 'UNAPPROVE_RIDER', 'rider', riderId, null, { is_approved }, ip)
    if (is_approved) {
      await this._queueBacklogAssignScan('RIDER_APPROVED')
    }
    return profile
  }

  async getDocuments(riderId) {
    return repo.getDocuments(riderId)
  }

  async verifyDocument(documentId, status, note, adminId, ip) {
    const doc = await repo.verifyDocument(documentId, status, note, adminId)
    logAdminActivity(adminId, 'VERIFY_DOCUMENT', 'rider_document', documentId, null, { status }, ip)
    return doc
  }

  async getLiveLocations() {
    return repo.getLiveLocations()
  }

  async _queueBacklogAssignScan(source) {
    try {
      await orderQueue.add(
        'auto-assign-backlog',
        {
          type: 'auto-assign-backlog',
          source,
          limit: 500,
        },
        {
          jobId: 'auto-assign-backlog-on-rider-approval',
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    } catch (err) {
      logger.warn({ err, source }, 'Failed to queue rider approval backlog scan')
    }
  }
}
