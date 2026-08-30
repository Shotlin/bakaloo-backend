import { BrandingService } from './branding.service.js'
import { success } from '../../../utils/apiResponse.js'

const svc = new BrandingService()

export class BrandingController {
  async get(request, reply) {
    return success(await svc.getBranding(), 'Branding fetched')
  }

  async update(request, reply) {
    const branding = await svc.updateBranding(request.body, request.user.id, request.ip)
    return success(branding, 'Branding updated')
  }
}
