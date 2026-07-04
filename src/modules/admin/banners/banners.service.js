import { AdminBannersRepository } from './banners.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { normalizeCloudinaryDeliveryUrl } from '../../../config/cloudinary.js'
import { getStoreStatusService } from '../../store-status/store-status.routes.js'

const repo = new AdminBannersRepository()

export class AdminBannersService {
  constructor(storeStatusService = null) {
    this._storeStatusService = storeStatusService
  }

  get storeStatusService() {
    return this._storeStatusService || getStoreStatusService()
  }

  async list() {
    return this._normalizeBanners(await repo.findAll())
  }

  async getById(id) {
    return this._normalizeBanner(await repo.findById(id))
  }

  async create(data, adminId, ip) {
    const mapped = {
      title: data.title,
      subtitle: data.subtitle,
      imageUrl: data.imageUrl,
      ctaText: data.linkType !== 'none' ? data.linkType : null,
      ctaLink: data.linkType !== 'none' ? data.linkValue : null,
      bannerType: data.bannerType === 'carousel' ? 'hero' : (data.bannerType || 'hero'),
      isActive: data.isActive,
      startDate: data.startDate,
      endDate: data.endDate,
      triggerType: data.triggerType,
    }
    const banner = await repo.create(mapped)
    logAdminActivity(adminId, 'CREATE_BANNER', 'banner', banner.id, null, null, ip)
    return this._normalizeBanner(banner)
  }

  async update(id, data, adminId, ip) {
    const mapped = {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
      ...(data.linkType !== undefined && { ctaText: data.linkType !== 'none' ? data.linkType : null }),
      ...(data.linkValue !== undefined && { ctaLink: data.linkValue }),
      ...(data.bannerType !== undefined && { bannerType: data.bannerType === 'carousel' ? 'hero' : data.bannerType }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
      ...(data.startDate !== undefined && { startDate: data.startDate }),
      ...(data.endDate !== undefined && { endDate: data.endDate }),
      ...(data.triggerType !== undefined && { triggerType: data.triggerType }),
    }
    const banner = await repo.update(id, mapped)
    logAdminActivity(adminId, 'UPDATE_BANNER', 'banner', id, null, null, ip)
    return this._normalizeBanner(banner)
  }

  async remove(id, adminId, ip) {
    const ok = await repo.remove(id)
    if (ok) logAdminActivity(adminId, 'DELETE_BANNER', 'banner', id, null, null, ip)
    return ok
  }

  async reorder(orderedIds, adminId, ip) {
    await repo.reorder(orderedIds)
    logAdminActivity(adminId, 'REORDER_BANNERS', 'banner', null, null, { count: orderedIds.length }, ip)
    return true
  }

  async getActive() {
    return this._normalizeBanners(await repo.findActive())
  }

  /**
   * Public-facing banner list filtered by each banner's trigger_type against
   * the current store-open/closed state — 'ALWAYS' banners always included,
   * 'STORE_CLOSED' banners only included while the store is closed.
   */
  async getActiveForStoreStatus() {
    const { isOpen } = await this.storeStatusService.isOpen()
    return this._normalizeBanners(await repo.findActiveForStoreStatus(isOpen))
  }

  _normalizeBanners(banners = []) {
    return banners.map((banner) => this._normalizeBanner(banner))
  }

  _normalizeBanner(banner) {
    if (!banner) return banner

    return {
      ...banner,
      image_url: normalizeCloudinaryDeliveryUrl(banner.image_url, 'default'),
    }
  }
}
