import { query, getClient } from '../../../config/database.js'

export class AdminTutorialsRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT id, title, video_url, video_id, language, sort_order, is_active, created_at, updated_at
       FROM tutorial_videos ORDER BY sort_order ASC, created_at DESC`
    )
    return rows
  }

  async findById(id) {
    const { rows: [t] } = await query(
      `SELECT id, title, video_url, video_id, language, sort_order, is_active, created_at, updated_at
       FROM tutorial_videos WHERE id = $1`,
      [id]
    )
    return t || null
  }

  async create({ title, videoUrl, videoId, language, isActive }) {
    const { rows: [{ max: maxOrder }] } = await query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max FROM tutorial_videos'
    )
    const { rows: [t] } = await query(
      `INSERT INTO tutorial_videos (title, video_url, video_id, language, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, video_url, video_id, language, sort_order, is_active, created_at, updated_at`,
      [title, videoUrl, videoId, language || null, (maxOrder || 0) + 1, isActive !== false]
    )
    return t
  }

  async update(id, data) {
    const sets = []; const params = []; let idx = 1
    const fields = ['title', 'video_url', 'video_id', 'language', 'is_active']
    const bodyMap = {
      title: 'title', video_url: 'videoUrl', video_id: 'videoId',
      language: 'language', is_active: 'isActive',
    }

    for (const col of fields) {
      const key = bodyMap[col]
      if (data[key] !== undefined) {
        sets.push(`${col} = $${idx++}`)
        params.push(data[key])
      }
    }
    if (sets.length === 0) return this.findById(id)

    sets.push(`updated_at = NOW()`)
    params.push(id)
    const { rows: [t] } = await query(
      `UPDATE tutorial_videos SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING id, title, video_url, video_id, language, sort_order, is_active, created_at, updated_at`,
      params
    )
    return t
  }

  async remove(id) {
    const { rowCount } = await query('DELETE FROM tutorial_videos WHERE id = $1', [id])
    return rowCount > 0
  }

  async reorder(orderedIds) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          'UPDATE tutorial_videos SET sort_order = $1, updated_at = NOW() WHERE id = $2',
          [i + 1, orderedIds[i]]
        )
      }
      await client.query('COMMIT')
      return true
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async findActive() {
    const { rows } = await query(
      `SELECT id, title, video_url, video_id, language, sort_order
       FROM tutorial_videos WHERE is_active = true ORDER BY sort_order ASC`
    )
    return rows
  }
}
