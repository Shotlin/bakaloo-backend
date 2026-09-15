import { query, getClient } from '../../../config/database.js'

const SELECT_COLUMNS = `
  id, label, icon_type, icon_key, accent_color,
  custom_icon_active_url, custom_icon_inactive_url,
  destination_type, destination_value, pass_identity,
  audience, target_segment_id,
  is_active, start_date, end_date, sort_order,
  created_at, updated_at
`

export class AdminNavButtonsRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${SELECT_COLUMNS} FROM nav_buttons ORDER BY sort_order ASC, created_at DESC`
    )
    return rows
  }

  async findById(id) {
    const { rows: [b] } = await query(
      `SELECT ${SELECT_COLUMNS} FROM nav_buttons WHERE id = $1`,
      [id]
    )
    return b || null
  }

  async create({
    label, iconType, iconKey, accentColor, customIconActiveUrl, customIconInactiveUrl,
    destinationType, destinationValue, passIdentity,
    audience, targetSegmentId, isActive, startDate, endDate,
  }, createdBy) {
    const { rows: [{ max: maxOrder }] } = await query('SELECT COALESCE(MAX(sort_order), 0) AS max FROM nav_buttons')
    const { rows: [b] } = await query(
      `INSERT INTO nav_buttons (
         label, icon_type, icon_key, accent_color, custom_icon_active_url, custom_icon_inactive_url,
         destination_type, destination_value, pass_identity,
         audience, target_segment_id, is_active, start_date, end_date, sort_order, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${SELECT_COLUMNS}`,
      [
        label, iconType || 'PRESET', iconKey || null, accentColor || null,
        customIconActiveUrl || null, customIconInactiveUrl || null,
        destinationType, destinationValue, !!passIdentity,
        audience || 'ALL', targetSegmentId || null, isActive !== false,
        startDate || null, endDate || null, (maxOrder || 0) + 1, createdBy,
      ]
    )
    return b
  }

  async update(id, data) {
    const sets = []; const params = []; let idx = 1
    const fields = [
      'label', 'icon_type', 'icon_key', 'accent_color',
      'custom_icon_active_url', 'custom_icon_inactive_url',
      'destination_type', 'destination_value',
      'pass_identity', 'audience', 'target_segment_id', 'is_active', 'start_date', 'end_date',
    ]
    const bodyMap = {
      label: 'label', icon_type: 'iconType', icon_key: 'iconKey', accent_color: 'accentColor',
      custom_icon_active_url: 'customIconActiveUrl', custom_icon_inactive_url: 'customIconInactiveUrl',
      destination_type: 'destinationType', destination_value: 'destinationValue',
      pass_identity: 'passIdentity', audience: 'audience', target_segment_id: 'targetSegmentId',
      is_active: 'isActive', start_date: 'startDate', end_date: 'endDate',
    }

    for (const col of fields) {
      const key = bodyMap[col]
      if (data[key] !== undefined) {
        sets.push(`${col} = $${idx++}`)
        params.push(data[key])
      }
    }
    if (sets.length === 0) return this.findById(id)

    sets.push('updated_at = NOW()')
    params.push(id)
    const { rows: [b] } = await query(
      `UPDATE nav_buttons SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${SELECT_COLUMNS}`,
      params
    )
    return b
  }

  async remove(id) {
    const { rowCount } = await query('DELETE FROM nav_buttons WHERE id = $1', [id])
    return rowCount > 0
  }

  async reorder(orderedIds) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          'UPDATE nav_buttons SET sort_order = $1, updated_at = NOW() WHERE id = $2',
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

  /**
   * Resolves the single 5th-nav-button the customer should see right now,
   * or null. Same active/date-window + audience + segment gate as banners
   * (findActiveForStoreStatus) — but only one row can ever render (there's
   * exactly one nav slot), so ties are broken deterministically: a
   * segment-targeted row is more specific than an untargeted one and wins
   * when both match this viewer, then by sort_order.
   */
  async findActiveForViewer(audience = 'B2C', userId = null) {
    const { rows: [b] } = await query(
      `SELECT ${SELECT_COLUMNS}
       FROM nav_buttons
       WHERE is_active = true
         AND (start_date IS NULL OR start_date <= NOW())
         AND (end_date IS NULL OR end_date >= NOW())
         AND audience IN ($1, 'ALL')
         AND (
           target_segment_id IS NULL
           OR ($2::uuid IS NOT NULL AND EXISTS (
             SELECT 1 FROM customer_segment_members csm
              WHERE csm.segment_id = target_segment_id AND csm.user_id = $2
           ))
         )
       ORDER BY (target_segment_id IS NOT NULL) DESC, sort_order ASC
       LIMIT 1`,
      [audience, userId]
    )
    return b || null
  }
}
