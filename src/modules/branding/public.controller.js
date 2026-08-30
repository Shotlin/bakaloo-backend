import { query } from '../../config/database.js'
import { redis } from '../../config/redis.js'
import { success } from '../../utils/apiResponse.js'
import { BRANDING_CACHE_KEY } from './branding-cache.js'

const CACHE_TTL = 300

function toResponseShape(row) {
  return {
    splashImageUrl: row?.splash_image_url ?? null,
    logoImageUrl: row?.logo_image_url ?? null,
  }
}

export class PublicBrandingController {
  async getBranding(request, reply) {
    const cached = await redis.get(BRANDING_CACHE_KEY)
    if (cached) {
      return success(JSON.parse(cached), 'App branding')
    }

    const { rows } = await query(
      'SELECT splash_image_url, logo_image_url FROM app_branding LIMIT 1'
    )

    const data = toResponseShape(rows[0])
    await redis.set(BRANDING_CACHE_KEY, JSON.stringify(data), 'EX', CACHE_TTL)

    return success(data, 'App branding')
  }
}
