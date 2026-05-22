import { AdminNotificationsRepository } from './notifications.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'

const repo = new AdminNotificationsRepository()

export class AdminNotificationsService {
  /* ── Templates CRUD ── */
  async listTemplates() {
    return repo.findAllTemplates()
  }

  async getTemplate(id) {
    return repo.findTemplateById(id)
  }

  async createTemplate(data, adminId, ip) {
    const t = await repo.createTemplate(data)
    logAdminActivity(adminId, 'CREATE_TEMPLATE', 'notification_template', t.id, null, null, ip)
    return t
  }

  async updateTemplate(id, data, adminId, ip) {
    const t = await repo.updateTemplate(id, data)
    logAdminActivity(adminId, 'UPDATE_TEMPLATE', 'notification_template', id, null, null, ip)
    return t
  }

  async deleteTemplate(id, adminId, ip) {
    const ok = await repo.deleteTemplate(id)
    if (ok) logAdminActivity(adminId, 'DELETE_TEMPLATE', 'notification_template', id, null, null, ip)
    return ok
  }

  /* ── Bulk / Campaign ── */
  async sendBulk({ title, body, segment, segmentFilters }, adminId, ip, notificationQueue) {
    const campaign = await repo.createCampaign({
      title, body, segment, segmentFilters, scheduledAt: null, createdBy: adminId,
    })

    // Get target users with FCM tokens
    const targets = await repo.getTargetUserIds(segment)

    // Send push notifications directly via Firebase Admin SDK
    // (BullMQ queue fallback if available, but direct send is reliable)
    const { sendPush } = await import('../../../utils/pushNotification.js')
    let sentCount = 0

    for (const t of targets) {
      try {
        const result = await sendPush(t.fcm_token, { title, body, data: { type: 'CAMPAIGN', campaignId: campaign.id } })
        if (result.success) sentCount++
      } catch {
        // Continue sending to other users even if one fails
      }
    }

    await repo.updateCampaignStatus(campaign.id, 'SENT', sentCount)
    logAdminActivity(adminId, 'SEND_BULK_NOTIFICATION', 'notification_campaign', campaign.id, null, { segment, count: sentCount }, ip)
    return { ...campaign, sent_count: sentCount }
  }

  async scheduleCampaign({ title, body, segment, segmentFilters, scheduledAt }, adminId, ip) {
    const campaign = await repo.createCampaign({
      title, body, segment, segmentFilters, scheduledAt, createdBy: adminId,
    })
    logAdminActivity(adminId, 'SCHEDULE_CAMPAIGN', 'notification_campaign', campaign.id, null, { scheduledAt }, ip)
    return campaign
  }

  async listCampaigns({ page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    return repo.findAllCampaigns({ offset, limit })
  }

  async getCampaign(id) {
    return repo.findCampaignById(id)
  }

  async getSegmentCount(segment, filters) {
    return repo.getSegmentCount(segment, filters)
  }
}
