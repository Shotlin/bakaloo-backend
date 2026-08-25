import sanitizeHtml from 'sanitize-html'
import { AdminLegalPagesRepository } from './legal-pages.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'

const repo = new AdminLegalPagesRepository()

// These pages are public and unauthenticated (no login required to view
// terms/privacy/about), so a compromised admin account submitting a
// script/onerror payload here would run in every visitor's browser —
// sanitize on write rather than trusting the dashboard's textarea alone.
const SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'strong', 'em', 'b', 'i', 'u', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'blockquote', 'a', 'span',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    span: ['class'],
    p: ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
  },
}

export class AdminLegalPagesService {
  async list() {
    return repo.findAll()
  }

  async getBySlug(slug) {
    return repo.findBySlug(slug)
  }

  async update(slug, { title, contentHtml }, adminId, ip) {
    const existing = await repo.findBySlug(slug)
    if (!existing) return null

    const cleanHtml = sanitizeHtml(contentHtml, SANITIZE_OPTIONS)
    const page = await repo.update(slug, { title, contentHtml: cleanHtml }, adminId)

    logAdminActivity(
      adminId,
      'UPDATE_LEGAL_PAGE',
      'legal_page',
      slug,
      { title: existing.title },
      { title: page.title },
      ip
    )

    return page
  }
}
