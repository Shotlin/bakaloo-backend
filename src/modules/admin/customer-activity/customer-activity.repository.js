import { query } from '../../../config/database.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PHONE_RE = /^[6-9]\d{9}$/

/**
 * Customer Activity repository — resolves a User ID/phone to a real user,
 * then builds a single chronological timeline out of every table that
 * records something a customer actually did. One UNION ALL CTE (not N
 * separate per-table queries merged in app code) is what makes real
 * pagination + filtering possible: LIMIT/OFFSET and the type/date filters
 * all apply to the merged result, and COUNT(*) OVER() gets the filtered
 * total in the same round trip.
 */
export class CustomerActivityRepository {
  /**
   * Resolve a User ID (UUID) or Indian mobile number to the matching
   * user's basic info — mirrors the identical resolve pattern already
   * used in wallet.service.js / coupons.repository.js / customers
   * module (kept self-contained here rather than a shared import, same
   * convention as those).
   */
  async resolveUser(input) {
    if (!input) return null
    if (UUID_RE.test(input)) {
      const { rows } = await query(
        `SELECT id, name, phone, role, created_at, last_active_at FROM users WHERE id = $1`,
        [input]
      )
      return rows[0] || null
    }
    if (PHONE_RE.test(input)) {
      const { rows } = await query(
        `SELECT id, name, phone, role, created_at, last_active_at FROM users WHERE phone = $1`,
        [input]
      )
      return rows[0] || null
    }
    return null
  }

  /**
   * Paginated, filterable activity timeline for one user, merged from
   * every source table that logs a real customer action. Each lane is
   * normalized to {event_type, event_at, meta} before the UNION so the
   * outer query can filter/sort/paginate them uniformly.
   */
  async getTimeline(userId, { eventType, from, to, limit, offset }) {
    const { rows } = await query(
      `WITH timeline AS (
         SELECT 'ORDER_PLACED' AS event_type, o.created_at AS event_at,
                jsonb_build_object(
                  'orderId', o.id, 'orderNumber', o.order_number,
                  'totalAmount', o.total_amount, 'paymentMethod', o.payment_method,
                  'status', o.status
                ) AS meta
           FROM orders o WHERE o.user_id = $1

         UNION ALL
         SELECT 'ORDER_STATUS', osh.changed_at,
                jsonb_build_object(
                  'orderId', osh.order_id, 'orderNumber', ord.order_number,
                  'fromStatus', osh.from_status, 'toStatus', osh.to_status,
                  'note', osh.note, 'changedByName', u.name, 'changedByRole', u.role
                )
           FROM order_status_history osh
           JOIN orders ord ON ord.id = osh.order_id
           LEFT JOIN users u ON u.id = osh.changed_by
          WHERE ord.user_id = $1

         UNION ALL
         SELECT 'WALLET', wt.created_at,
                jsonb_build_object(
                  'type', wt.type, 'amount', wt.amount,
                  'description', wt.description, 'balanceAfter', wt.balance_after
                )
           FROM wallet_transactions wt
           JOIN wallets w ON w.id = wt.wallet_id
          WHERE w.user_id = $1

         UNION ALL
         SELECT 'NOTIFICATION', n.created_at,
                jsonb_build_object('title', n.title, 'type', n.type, 'isRead', n.is_read)
           FROM notifications n WHERE n.user_id = $1

         UNION ALL
         SELECT 'REVIEW', r.created_at,
                jsonb_build_object('productName', p.name, 'rating', r.rating, 'comment', r.comment)
           FROM reviews r JOIN products p ON p.id = r.product_id
          WHERE r.user_id = $1

         UNION ALL
         SELECT 'PRODUCT_VIEW', pv.viewed_at,
                jsonb_build_object('productName', p.name, 'source', pv.source)
           FROM product_views pv JOIN products p ON p.id = pv.product_id
          WHERE pv.user_id = $1

         UNION ALL
         SELECT 'CART_EVENT', ce.created_at,
                jsonb_build_object(
                  'eventType', ce.event_type, 'actorType', ce.actor_type,
                  'cartValue', ac.cart_value
                )
           FROM abandoned_cart_events ce
           JOIN abandoned_carts ac ON ac.id = ce.abandoned_cart_id
          WHERE ac.user_id = $1

         UNION ALL
         SELECT 'ADDRESS_ADDED', a.created_at,
                jsonb_build_object('label', a.label, 'city', a.city)
           FROM addresses a WHERE a.user_id = $1

         UNION ALL
         SELECT 'ADDRESS_REMOVED', a.deleted_at,
                jsonb_build_object('label', a.label, 'city', a.city)
           FROM addresses a WHERE a.user_id = $1 AND a.deleted_at IS NOT NULL
       )
       SELECT *, COUNT(*) OVER()::int AS total_count
         FROM timeline
        WHERE ($2::text IS NULL OR event_type = $2)
          AND ($3::timestamptz IS NULL OR event_at >= $3)
          AND ($4::timestamptz IS NULL OR event_at <= $4)
        ORDER BY event_at DESC
        LIMIT $5 OFFSET $6`,
      [userId, eventType || null, from || null, to || null, limit, offset]
    )

    const total = rows[0]?.total_count ?? 0
    const events = rows.map((r) => ({
      eventType: r.event_type,
      eventAt: r.event_at,
      meta: r.meta,
    }))

    return { events, total }
  }
}
