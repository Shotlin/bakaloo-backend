import { AdminLegalPagesService } from './legal-pages.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminLegalPagesService()

export class AdminLegalPagesController {
  async list(request, reply) {
    const data = await svc.list()
    return success(data, 'Legal pages fetched')
  }

  async getBySlug(request, reply) {
    const page = await svc.getBySlug(request.params.slug)
    if (!page) return error('Page not found', 404)
    return success(page, 'Legal page fetched')
  }

  async update(request, reply) {
    const page = await svc.update(
      request.params.slug,
      request.body,
      request.user.id,
      request.ip
    )
    if (!page) return error('Page not found', 404)
    return success(page, 'Legal page updated')
  }
}
