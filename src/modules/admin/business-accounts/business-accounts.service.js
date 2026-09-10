import { logAdminActivity } from '../../../utils/activityLogger.js'
import { BusinessAccountsRepository } from '../../business-accounts/business-accounts.repository.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { NotificationsService } from '../../notifications/notifications.service.js'

export class AdminBusinessAccountsService {
  constructor(repository = new BusinessAccountsRepository(), fastify = null) {
    this.repository = repository
    this.fastify = fastify
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
  }

  async findAll(filters) {
    const { rows, total } = await this.repository.list(filters)
    return {
      requests: rows,
      pagination: {
        page: filters.page || 1,
        limit: filters.limit || 20,
        total,
        totalPages: Math.ceil(total / (filters.limit || 20)),
      },
    }
  }

  async findById(id) {
    const account = await this.repository.findById(id)
    if (!account) throw { statusCode: 404, message: 'Business account not found' }
    return account
  }

  async _queueNotification(userId, notif) {
    if (!this.notificationsService || !userId || !notif) return
    try {
      await this.notificationsService.sendNotification(userId, notif)
    } catch (err) {
      console.error('Failed to send customer notification:', err?.message || err)
    }
  }

  async approve(id, { comments } = {}, adminId, ip) {
    const account = await this.repository.findById(id)
    if (!account) throw { statusCode: 404, message: 'Business account not found' }
    if (account.status !== 'PENDING') {
      throw { statusCode: 400, message: `Cannot approve an application that is already ${account.status}` }
    }

    const updated = await this.repository.transitionStatus(id, {
      newStatus: 'APPROVED',
      reviewerId: adminId,
      comments,
      action: 'APPROVE',
    })

    logAdminActivity(
      adminId,
      `Approved B2B application for ${account.company_name} (GSTIN ${account.gst_number})`,
      'business_account', id,
      { status: 'PENDING' }, { status: 'APPROVED' },
      ip
    )

    await this._queueNotification(account.user_id, {
      title: 'Your B2B application was approved',
      body: `${account.company_name} is now an approved business account — you can enable B2B pricing from your profile.`,
      type: 'BUSINESS_ACCOUNT',
      data: { type: 'BUSINESS_ACCOUNT', businessAccountId: id, status: 'APPROVED' },
    })

    return updated
  }

  async reject(id, { reason } = {}, adminId, ip) {
    const account = await this.repository.findById(id)
    if (!account) throw { statusCode: 404, message: 'Business account not found' }
    if (account.status !== 'PENDING') {
      throw { statusCode: 400, message: `Cannot reject an application that is already ${account.status}` }
    }

    const updated = await this.repository.transitionStatus(id, {
      newStatus: 'REJECTED',
      reviewerId: adminId,
      comments: reason,
      action: 'REJECT',
      rejectionReason: reason,
    })

    logAdminActivity(
      adminId,
      `Rejected B2B application for ${account.company_name} (GSTIN ${account.gst_number})`,
      'business_account', id,
      { status: 'PENDING' }, { status: 'REJECTED', reason },
      ip
    )

    await this._queueNotification(account.user_id, {
      title: 'Your B2B application needs attention',
      body: `Your business account application for ${account.company_name} was not approved: ${reason}`,
      type: 'BUSINESS_ACCOUNT',
      data: { type: 'BUSINESS_ACCOUNT', businessAccountId: id, status: 'REJECTED' },
    })

    return updated
  }
}
