import { BrandingRepository } from './branding.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { redis } from '../../../config/redis.js'
import { getSocketIo } from '../../../plugins/socketio.plugin.js'
import { logger } from '../../../config/logger.js'
import { BRANDING_CACHE_KEY } from '../../branding/branding-cache.js'

const repo = new BrandingRepository()

function toResponseShape(row) {
  return {
    splashImageUrl: row?.splash_image_url ?? null,
    logoImageUrl: row?.logo_image_url ?? null,
  }
}

function broadcastBrandingUpdate(data) {
  const io = getSocketIo()
  if (!io) {
    return
  }

  io.to('themes:live').emit('branding:update', {
    ...data,
    timestamp: new Date().toISOString(),
  })
  logger.info(data, 'Branding update broadcasted to all users')
}

export class BrandingService {
  async getBranding() {
    const row = await repo.find()
    return toResponseShape(row)
  }

  async updateBranding(data, adminId, ip) {
    const row = await repo.update({
      splash_image_url: data.splashImageUrl,
      logo_image_url: data.logoImageUrl,
    })

    const responseData = toResponseShape(row)

    await redis.del(BRANDING_CACHE_KEY)
    logAdminActivity(adminId, 'UPDATE_APP_BRANDING', 'app_branding', row.id, null, responseData, ip)
    broadcastBrandingUpdate(responseData)

    return responseData
  }
}
