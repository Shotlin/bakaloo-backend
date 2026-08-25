import { query } from '../../../config/database.js'

export class AdminLegalPagesRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT slug, title, content_html, updated_at, updated_by
       FROM legal_pages ORDER BY slug ASC`
    )
    return rows
  }

  async findBySlug(slug) {
    const { rows } = await query(
      `SELECT slug, title, content_html, updated_at, updated_by
       FROM legal_pages WHERE slug = $1`,
      [slug]
    )
    return rows[0] || null
  }

  async update(slug, { title, contentHtml }, adminId) {
    const { rows } = await query(
      `UPDATE legal_pages
       SET title = $1, content_html = $2, updated_at = NOW(), updated_by = $3
       WHERE slug = $4
       RETURNING slug, title, content_html, updated_at, updated_by`,
      [title, contentHtml, adminId, slug]
    )
    return rows[0] || null
  }
}
