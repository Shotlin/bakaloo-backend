import { query } from '../../config/database.js'

/**
 * Shop Transactions repository — append-only ledger SQL.
 *
 * Conventions (Requirements 14.5, 14.7):
 *   - NEVER `SELECT *` — every column is named explicitly
 *   - All queries use parameterized placeholders ($1, $2…)
 *   - Append-only enforcement (Requirements 7.3, 7.4, 15.1):
 *       * NO `update*` / `delete*` / `softDelete*` methods exist.
 *       * The only mutation is `insertEntry()`, which executes a single
 *         INSERT inside a caller-owned transaction.
 *   - Reads:
 *       * `findManyByShop()` — paginated, filterable history
 *       * `findById()` — single-row lookup scoped to a shop
 *       * `findCurrentBalance()` — latest balance_after for a shop (cheap)
 *   - Internal ledger write:
 *       * `lockLatestForShop(client, shopId)` — SELECT … FOR UPDATE on the
 *         most recent row. Returns null if the shop has no entries yet.
 *       * `insertEntry(client, row)` — appends a precomputed row. The caller
 *         (LedgerWriteService) is responsible for computing balance_after
 *         under the FOR UPDATE lock.
 *
 * Migration reference: src/database/migrations/035_shop_transactions.sql
 */
export class ShopTransactionsRepository {
  // ────────────────────────────────────────────────────────
  // Column projection — keep in sync with the migration
  // ────────────────────────────────────────────────────────
  static SELECT_COLUMNS = `
    id, shop_id, type, amount, balance_after,
    reference_type, reference_id, description,
    created_by, created_at
  `

  // ════════════════════════════════════════════════════════
  // READ-ONLY QUERIES (used by the public API)
  // ════════════════════════════════════════════════════════

  /**
   * Find a single ledger entry by id, scoped to a shop.
   * @param {string} id - shop_transaction UUID
   * @param {string} shopId - Shop UUID for scope enforcement (Req 13.6)
   * @returns {Promise<object|null>}
   */
  async findById(id, shopId) {
    const { rows } = await query(
      `SELECT ${ShopTransactionsRepository.SELECT_COLUMNS}
         FROM shop_transactions
        WHERE id = $1 AND shop_id = $2`,
      [id, shopId]
    )
    return rows[0] || null
  }

  /**
   * Paginated list of ledger entries for a shop, newest first.
   * Uses idx_shop_transactions_shop_created (shop_id, created_at DESC) when
   * unfiltered, and idx_shop_transactions_shop_type_created when `type` is set.
   *
   * @param {object} filters
   * @param {string} filters.shopId
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=50]
   * @param {string} [filters.type]
   * @param {string} [filters.reference_type]
   * @param {string} [filters.reference_id]
   * @param {Date}   [filters.from] - inclusive
   * @param {Date}   [filters.to]   - exclusive
   * @returns {Promise<{items: Array, total: number}>}
   */
  async findManyByShop({
    shopId,
    page = 1,
    limit = 50,
    type,
    reference_type,
    reference_id,
    from,
    to,
  }) {
    const offset = (page - 1) * limit
    const conditions = ['shop_id = $1']
    const params = [shopId]
    let idx = 2

    if (type) {
      conditions.push(`type = $${idx++}`)
      params.push(type)
    }
    if (reference_type) {
      conditions.push(`reference_type = $${idx++}`)
      params.push(reference_type)
    }
    if (reference_id) {
      conditions.push(`reference_id = $${idx++}`)
      params.push(reference_id)
    }
    if (from instanceof Date) {
      conditions.push(`created_at >= $${idx++}`)
      params.push(from)
    }
    if (to instanceof Date) {
      conditions.push(`created_at < $${idx++}`)
      params.push(to)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${ShopTransactionsRepository.SELECT_COLUMNS}
           FROM shop_transactions
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shop_transactions
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Read the latest balance_after for a shop (current balance).
   * Cheap O(1) read backed by idx_shop_transactions_shop_created.
   * Returns "0.00" when the shop has no ledger entries yet (Requirement 7.8).
   *
   * @param {string} shopId
   * @returns {Promise<{ balance: string, last_entry_at: Date|null }>}
   */
  async findCurrentBalance(shopId) {
    const { rows } = await query(
      `SELECT balance_after, created_at
         FROM shop_transactions
        WHERE shop_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [shopId]
    )
    if (!rows[0]) {
      return { balance: '0.00', last_entry_at: null }
    }
    return {
      balance: String(rows[0].balance_after),
      last_entry_at: rows[0].created_at,
    }
  }

  // ════════════════════════════════════════════════════════
  // TRANSACTIONAL HELPERS — caller owns BEGIN/COMMIT
  // ════════════════════════════════════════════════════════
  //
  // These are the ONLY mutation paths exposed by the repository.
  // They do not mutate existing rows — `insertEntry` only INSERTs.
  // No `update*` / `delete*` / `softDelete*` method exists, so the
  // append-only invariant (Req 7.3, 7.4, 15.1) is enforced structurally.

  /**
   * Lock the most recent ledger row for a shop and return it.
   * Used by LedgerWriteService to read the previous balance under a row-level
   * lock before computing balance_after (Requirement 7.7).
   *
   * Returns null when the shop has no prior entries — the caller MUST treat
   * the previous balance as 0.00 in that case (Requirement 7.8).
   *
   * @param {import('pg').PoolClient} client - Transactional client (BEGIN already issued)
   * @param {string} shopId
   * @returns {Promise<object|null>}
   */
  async lockLatestForShop(client, shopId) {
    const { rows } = await client.query(
      `SELECT ${ShopTransactionsRepository.SELECT_COLUMNS}
         FROM shop_transactions
        WHERE shop_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [shopId]
    )
    return rows[0] || null
  }

  /**
   * Append a ledger entry inside an open transaction.
   *
   * Caller (LedgerWriteService) is responsible for:
   *   - computing balance_after under the FOR UPDATE lock,
   *   - validating amount/type/reference_type against the schema,
   *   - committing or rolling back the surrounding transaction.
   *
   * @param {import('pg').PoolClient} client
   * @param {object} row
   * @param {string} row.shop_id
   * @param {string} row.type
   * @param {number|string} row.amount
   * @param {number|string} row.balance_after
   * @param {string} row.reference_type
   * @param {string|null} [row.reference_id]
   * @param {string|null} [row.description]
   * @param {string|null} [row.created_by]
   * @returns {Promise<object>} the inserted row
   */
  async insertEntry(client, row) {
    const { rows } = await client.query(
      `INSERT INTO shop_transactions (
         shop_id, type, amount, balance_after,
         reference_type, reference_id, description, created_by
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8
       )
       RETURNING ${ShopTransactionsRepository.SELECT_COLUMNS}`,
      [
        row.shop_id,
        row.type,
        row.amount,
        row.balance_after,
        row.reference_type,
        row.reference_id ?? null,
        row.description ?? null,
        row.created_by ?? null,
      ]
    )
    return rows[0]
  }
}
