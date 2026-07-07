import { query, getClient } from '../../config/database.js'

/**
 * Product Suggestions repository — admin-managed category-to-category
 * mapping (migration 080) that drives products.repository.js's
 * findPairWith(). A source category with zero rows here has no configured
 * rule, and findPairWith() falls back to its original any-other-category
 * behavior for it.
 */
export class ProductSuggestionsRepository {
  /** All active rules, grouped by source category (dashboard's list view). */
  async getAllRulesGrouped() {
    const { rows } = await query(
      `SELECT
         sc.id AS source_category_id, sc.name AS source_category_name,
         r.id AS rule_id, r.display_order, r.is_active,
         tc.id AS target_category_id, tc.name AS target_category_name
       FROM categories sc
       LEFT JOIN category_suggestion_rules r
         ON r.source_category_id = sc.id AND r.is_active = true
       LEFT JOIN categories tc ON tc.id = r.target_category_id
       WHERE sc.is_active = true
       ORDER BY sc.name ASC, r.display_order ASC, tc.name ASC`
    )

    const bySource = new Map()
    for (const row of rows) {
      if (!bySource.has(row.source_category_id)) {
        bySource.set(row.source_category_id, {
          sourceCategoryId: row.source_category_id,
          sourceCategoryName: row.source_category_name,
          targetCategories: [],
        })
      }
      if (row.target_category_id) {
        bySource.get(row.source_category_id).targetCategories.push({
          categoryId: row.target_category_id,
          categoryName: row.target_category_name,
        })
      }
    }
    return Array.from(bySource.values())
  }

  /** Active target_category_ids for one source category, ordered — the hot lookup path (cached by the service). */
  async getTargetCategoryIds(sourceCategoryId) {
    const { rows } = await query(
      `SELECT target_category_id FROM category_suggestion_rules
       WHERE source_category_id = $1 AND is_active = true
       ORDER BY display_order ASC`,
      [sourceCategoryId]
    )
    return rows.map((r) => r.target_category_id)
  }

  /** Replace the full target-category list for one source category atomically. */
  async replaceRulesForSource(sourceCategoryId, targetCategoryIds) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        'DELETE FROM category_suggestion_rules WHERE source_category_id = $1',
        [sourceCategoryId]
      )
      let order = 0
      for (const targetCategoryId of targetCategoryIds) {
        await client.query(
          `INSERT INTO category_suggestion_rules
             (source_category_id, target_category_id, display_order, is_active)
           VALUES ($1, $2, $3, true)`,
          [sourceCategoryId, targetCategoryId, order]
        )
        order += 1
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return this.getTargetCategoryIds(sourceCategoryId)
  }
}
