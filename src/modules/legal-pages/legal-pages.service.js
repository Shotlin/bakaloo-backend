import { LegalPagesRepository } from './legal-pages.repository.js'

const repo = new LegalPagesRepository()

export class LegalPagesService {
  async getBySlug(slug) {
    return repo.findBySlug(slug)
  }
}
