import { query, getClient } from '../../../config/database.js'

export class AdminNotificationsRepository {
  /* ── Templates ── */
  async findAllTemplates() {
    const { rows } = await query('SELECT * FROM notification_templates ORDER BY name')
    return rows
  }

  async findTemplateById(id) {
    const { rows: [t] } = await query('SELECT * FROM notification_templates WHERE id = $1', [id])
    return t || null
  }

  async createTemplate({ name, title, body, type, variables }) {
    const { rows: [t] } = await query(
      `INSERT INTO notification_templates (name, title, body, type, variables)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, title, body, type, JSON.stringify(variables || [])]
    )
    return t
  }

  async updateTemplate(id, { name, title, body, type, variables }) {
    const sets = []; const params = []; let idx = 1
    if (name !== undefined) { sets.push(`name = $${idx++}`); params.push(name) }
    if (title !== undefined) { sets.push(`title = $${idx++}`); params.push(title) }
    if (body !== undefined) { sets.push(`body = $${idx++}`); params.push(body) }
    if (type !== undefined) { sets.push(`type = $${idx++}`); params.push(type) }
    if (variables !== undefined) { sets.push(`variables = $${idx++}`); params.push(JSON.stringify(variables)) }
    if (sets.length === 0) return this.findTemplateById(id)

    sets.push(`updated_at = NOW()`)
    params.push(id)
    const { rows: [t] } = await query(
      `UPDATE notification_templates SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    )
    return t
  }

  async deleteTemplate(id) {
    const { rowCount } = await query('DELETE FROM notification_templates WHERE id = $1', [id])
    return rowCount > 0
  }

  /* ── Campaigns ── */
  async createCampaign({ title, body, segment, segmentFilters, scheduledAt, createdBy }) {
    // Map API segment names to DB target_type CHECK constraint values
    const segmentToTargetType = {
      all: 'all_customers',
      new: 'all_customers',
      inactive: 'no_order_30_days',
      high_value: 'high_value',
    }
    const targetType = segmentToTargetType[segment] || 'all_customers'

    const { rows: [c] } = await query(
      `INSERT INTO notification_campaigns (title, body, target_type, scheduled_at, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title, body, targetType, scheduledAt || null,
        scheduledAt ? 'SCHEDULED' : 'SENDING', createdBy]
    )
    return c
  }

  async findAllCampaigns({ offset, limit }) {
    const { rows } = await query(
      `SELECT nc.*, u.name AS created_by_name
       FROM notification_campaigns nc
       LEFT JOIN users u ON u.id = nc.created_by
       ORDER BY nc.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    const countRes = await query('SELECT COUNT(*)::int AS total FROM notification_campaigns')
    return { campaigns: rows, total: countRes.rows[0].total }
  }

  async findCampaignById(id) {
    const { rows: [c] } = await query(
      `SELECT nc.*, u.name AS created_by_name
       FROM notification_campaigns nc
       LEFT JOIN users u ON u.id = nc.created_by
       WHERE nc.id = $1`,
      [id]
    )
    return c || null
  }

  async updateCampaignStatus(id, status, sentCount) {
    const sets = ['status = $1']
    const params = [status, id]
    if (sentCount !== undefined) {
      sets.push('sent_count = $3')
      params.push(sentCount)
    }
    if (status === 'SENT') {
      sets.push('sent_at = NOW()')
    }
    const { rows: [c] } = await query(
      `UPDATE notification_campaigns SET ${sets.join(', ')} WHERE id = $2 RETURNING *`,
      params
    )
    return c
  }

  /* ── Target audience count ── */
  async getSegmentCount(segment, filters = {}) {
    let where = "u.role = 'CUSTOMER' AND u.is_active = true"
    const params = []

    if (segment === 'all') {
      // no extra filter
    } else if (segment === 'new') {
      where += ` AND u.created_at >= NOW() - INTERVAL '30 days'`
    } else if (segment === 'inactive') {
      where += ` AND u.id NOT IN (SELECT DISTINCT user_id FROM orders WHERE created_at >= NOW() - INTERVAL '30 days')`
    } else if (segment === 'high_value') {
      where += ` AND u.id IN (SELECT user_id FROM orders WHERE status = 'DELIVERED' GROUP BY user_id HAVING SUM(total) >= 5000)`
    }

    const { rows: [{ count }] } = await query(
      `SELECT COUNT(DISTINCT u.id)::int AS count 
       FROM users u 
       INNER JOIN fcm_tokens ft ON ft.user_id = u.id
       WHERE ${where}`,
      params
    )
    return count
  }

  async getTargetUserIds(segment) {
    let where = "u.role = 'CUSTOMER' AND u.is_active = true"
    if (segment === 'new') where += ` AND u.created_at >= NOW() - INTERVAL '30 days'`
    else if (segment === 'inactive') where += ` AND u.id NOT IN (SELECT DISTINCT user_id FROM orders WHERE created_at >= NOW() - INTERVAL '30 days')`
    else if (segment === 'high_value') where += ` AND u.id IN (SELECT user_id FROM orders WHERE status = 'DELIVERED' GROUP BY user_id HAVING SUM(total) >= 5000)`

    const { rows } = await query(
      `SELECT DISTINCT u.id, ft.token AS fcm_token 
       FROM users u 
       INNER JOIN fcm_tokens ft ON ft.user_id = u.id
       WHERE ${where}`
    )
    return rows
  }
}
