import { query } from '../../config/database.js'

/**
 * Public read access to legal_pages (migration 108). Admin CRUD lives
 * separately in src/modules/admin/legal-pages/ — this module only ever
 * reads, and only rows that exist (no soft-delete/draft state yet).
 */
export class LegalPagesRepository {
  async findBySlug(slug) {
    const { rows } = await query(
      `SELECT slug, title, content_html, updated_at
       FROM legal_pages WHERE slug = $1`,
      [slug]
    )
    return rows[0] || null
  }
}
