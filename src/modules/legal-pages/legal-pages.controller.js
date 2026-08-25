import { LegalPagesService } from './legal-pages.service.js'
import { success, error } from '../../utils/apiResponse.js'

const svc = new LegalPagesService()

export class LegalPagesController {
  async getBySlug(request, reply) {
    const page = await svc.getBySlug(request.params.slug)
    if (!page) return error('Page not found', 404)
    return success(page, 'Legal page fetched')
  }
}
