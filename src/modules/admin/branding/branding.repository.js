import { query } from '../../../config/database.js'

export class BrandingRepository {
  async find() {
    const { rows: [row] } = await query(
      'SELECT * FROM app_branding LIMIT 1'
    )
    return row || null
  }

  async update({ splash_image_url, logo_image_url }) {
    const existing = await this.find()

    if (!existing) {
      const { rows: [row] } = await query(
        `INSERT INTO app_branding (splash_image_url, logo_image_url)
         VALUES ($1, $2)
         RETURNING *`,
        [splash_image_url ?? null, logo_image_url ?? null]
      )
      return row
    }

    const { rows: [row] } = await query(
      `UPDATE app_branding
       SET splash_image_url = $1,
           logo_image_url = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [splash_image_url ?? null, logo_image_url ?? null, existing.id]
    )
    return row
  }
}
