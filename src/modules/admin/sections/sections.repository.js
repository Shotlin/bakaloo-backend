import { getClient, query } from '../../../config/database.js'

const SECTION_SELECT = `
  SELECT
    sm.*,
    tt.key AS tab_key,
    tt.store_key
  FROM section_manifests sm
  JOIN theme_tabs tt ON tt.id = sm.tab_id
`

export class SectionsRepository {
  async findTabById(tabId) {
    const { rows: [tab] } = await query(
      `SELECT id, key, store_key
       FROM theme_tabs
       WHERE id = $1`,
      [tabId]
    )
    return tab || null
  }

  /**
   * Admin listing — exact audience match only, no B2C fallback. The admin
   * needs to see exactly what exists for the audience they've selected
   * (including "nothing yet") so the Section Builder's audience toggle is
   * never ambiguous about which set they're editing. The public/mobile
   * read path (public.controller.js) has its own separate fallback query.
   */
  async findByTabId(tabId, audience = 'B2C') {
    const { rows } = await query(
      `SELECT * FROM section_manifests
       WHERE tab_id = $1 AND audience = $2
       ORDER BY sort_order ASC`,
      [tabId, audience]
    )
    return rows
  }

  async findById(id) {
    const { rows: [section] } = await query(
      `${SECTION_SELECT}
       WHERE sm.id = $1`,
      [id]
    )
    return section || null
  }

  async create(tabId, data) {
    const audience = data.audience || 'B2C'
    const { rows: [{ max_order }] } = await query(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order
       FROM section_manifests
       WHERE tab_id = $1 AND audience = $2`,
      [tabId, audience]
    )

    const { rows: [section] } = await query(
      `INSERT INTO section_manifests (
         tab_id,
         section_type,
         sort_order,
         visible,
         config,
         merch_binding,
         audience
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [
        tabId,
        data.section_type,
        max_order + 1,
        data.visible ?? true,
        JSON.stringify(data.config || {}),
        data.merch_binding ? JSON.stringify(data.merch_binding) : null,
        audience,
      ]
    )

    return section
  }

  async update(id, data) {
    const sets = []
    const params = []
    let idx = 1

    if (data.config !== undefined) {
      sets.push(`config = $${idx++}::jsonb`)
      params.push(JSON.stringify(data.config))
    }

    if (data.visible !== undefined) {
      sets.push(`visible = $${idx++}`)
      params.push(data.visible)
    }

    if (data.section_type !== undefined) {
      sets.push(`section_type = $${idx++}`)
      params.push(data.section_type)
    }

    if (sets.length === 0) {
      return this.findById(id)
    }

    params.push(id)

    const { rows: [section] } = await query(
      `UPDATE section_manifests
       SET ${sets.join(', ')}
       WHERE id = $${idx}
       RETURNING *`,
      params
    )

    return section || null
  }

  async updateMerchBinding(id, merchBinding) {
    const { rows: [section] } = await query(
      `UPDATE section_manifests
       SET merch_binding = $1::jsonb
       WHERE id = $2
       RETURNING *`,
      [merchBinding ? JSON.stringify(merchBinding) : null, id]
    )

    return section || null
  }

  async delete(id) {
    const section = await this.findById(id)
    if (!section) return null

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM section_manifests WHERE id = $1', [id])
      // Renumber only the same (tab_id, audience) sequence the deleted row
      // belonged to — otherwise deleting a B2C section would also shuffle
      // the independent B2B sort_order sequence for the same tab.
      await client.query(
        `WITH numbered AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order ASC, created_at ASC) - 1 AS new_order
           FROM section_manifests
           WHERE tab_id = $1 AND audience = $2
         )
         UPDATE section_manifests sm
         SET sort_order = numbered.new_order
         FROM numbered
         WHERE sm.id = numbered.id`,
        [section.tab_id, section.audience]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return section
  }

  async reorder(tabId, orderedIds, audience = 'B2C') {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedIds.length; i++) {
        // Scoped by audience too — orderedIds always comes from an
        // audience-filtered listing on the caller side, but this keeps the
        // write itself from ever touching the other audience's rows even
        // if a stale id slipped through.
        await client.query(
          `UPDATE section_manifests
           SET sort_order = $1
           WHERE id = $2 AND tab_id = $3 AND audience = $4`,
          [i, orderedIds[i], tabId, audience]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return this.findByTabId(tabId, audience)
  }

  async duplicate(id) {
    const original = await this.findById(id)
    if (!original) return null

    const { rows: [{ max_order }] } = await query(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order
       FROM section_manifests
       WHERE tab_id = $1 AND audience = $2`,
      [original.tab_id, original.audience]
    )

    const { rows: [section] } = await query(
      `INSERT INTO section_manifests (
         tab_id,
         section_type,
         sort_order,
         visible,
         config,
         merch_binding,
         audience
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [
        original.tab_id,
        original.section_type,
        max_order + 1,
        original.visible,
        JSON.stringify(original.config || {}),
        original.merch_binding ? JSON.stringify(original.merch_binding) : null,
        original.audience,
      ]
    )

    return section || null
  }

  /**
   * Bulk-bootstrap a tab's B2B section list from its current B2C one — the
   * Section Builder's "Copy B2C to B2B" action. Refuses to run if the
   * target audience already has sections (the admin would need to delete
   * them first), so this can never silently duplicate/clobber real B2B
   * work in progress.
   */
  async copySections(tabId, fromAudience, toAudience) {
    const existing = await this.findByTabId(tabId, toAudience)
    if (existing.length > 0) {
      return { copied: 0, alreadyHadSections: true, sections: existing }
    }

    const source = await this.findByTabId(tabId, fromAudience)
    if (source.length === 0) {
      return { copied: 0, alreadyHadSections: false, sections: [] }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (const section of source) {
        await client.query(
          `INSERT INTO section_manifests (
             tab_id, section_type, sort_order, visible, config, merch_binding, audience
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
          [
            tabId,
            section.section_type,
            section.sort_order,
            section.visible,
            JSON.stringify(section.config || {}),
            section.merch_binding ? JSON.stringify(section.merch_binding) : null,
            toAudience,
          ]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return {
      copied: source.length,
      alreadyHadSections: false,
      sections: await this.findByTabId(tabId, toAudience),
    }
  }

  async createVersion(tabId, snapshot, createdBy, options = {}) {
    const {
      scheduledAt = null,
      status = 'applied',
      abVariant = 'A',
      abSplitPercent = 0,
      audience = 'B2C',
    } = options

    const { rows: [version] } = await query(
      `INSERT INTO section_manifest_versions (
         tab_id,
         version,
         snapshot,
         created_by,
         scheduled_at,
         status,
         ab_variant,
         ab_split_percent,
         audience
       )
       VALUES (
         $1,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM section_manifest_versions WHERE tab_id = $1 AND audience = $8),
         $2::jsonb,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8
       )
       RETURNING *`,
      [
        tabId,
        JSON.stringify(snapshot || []),
        createdBy,
        scheduledAt,
        status,
        abVariant,
        abSplitPercent,
        audience,
      ]
    )

    return version || null
  }

  async getVersions(tabId, audience = 'B2C') {
    const { rows } = await query(
      `SELECT
         id,
         version,
         created_by,
         scheduled_at,
         status,
         ab_variant,
         ab_split_percent,
         created_at
       FROM section_manifest_versions
       WHERE tab_id = $1 AND audience = $2
       ORDER BY version DESC
       LIMIT 50`,
      [tabId, audience]
    )
    return rows
  }

  async findVersionById(tabId, versionId) {
    const { rows: [version] } = await query(
      `SELECT *
       FROM section_manifest_versions
       WHERE id = $1 AND tab_id = $2`,
      [versionId, tabId]
    )
    return version || null
  }

  async expireScheduledVersions(tabId, audience = 'B2C') {
    const { rows } = await query(
      `UPDATE section_manifest_versions
       SET status = 'expired'
       WHERE tab_id = $1
         AND audience = $2
         AND status = 'scheduled'
       RETURNING *`,
      [tabId, audience]
    )
    return rows
  }

  async restoreSnapshot(tabId, snapshot, audience = 'B2C') {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Scoped by audience — restoring a B2C rollback must never touch
      // that tab's independent B2B section list.
      await client.query(
        'DELETE FROM section_manifests WHERE tab_id = $1 AND audience = $2',
        [tabId, audience]
      )

      const orderedSnapshot = [...(snapshot || [])].sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
      )

      for (const section of orderedSnapshot) {
        await client.query(
          `INSERT INTO section_manifests (
             tab_id,
             section_type,
             sort_order,
             visible,
             config,
             merch_binding,
             audience
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
          [
            tabId,
            section.section_type,
            section.sort_order ?? 0,
            section.visible ?? true,
            JSON.stringify(section.config || {}),
            section.merch_binding ? JSON.stringify(section.merch_binding) : null,
            audience,
          ]
        )
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return this.findByTabId(tabId, audience)
  }
}
