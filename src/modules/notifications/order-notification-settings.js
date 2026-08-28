import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

/**
 * Canonical registry of every customer-facing order-lifecycle notification
 * (see customer-order-event.helper.js's messageMap for the matching
 * title/body text) and the app_settings key that toggles it on/off from the
 * dashboard (Settings → Order Notifications).
 *
 * `defaultEnabled` is the value used when no app_settings row exists yet for
 * a key — this is what lets the four "too spammy" events (see migration
 * 110_order_event_notification_settings.sql) ship disabled the moment this
 * code deploys, with no DB write required.
 */
export const ORDER_NOTIFICATION_EVENTS = [
  {
    timelineType: 'ORDER_PLACED',
    settingKey: 'notify_evt_order_placed',
    label: 'Order placed',
    description: "Sent the moment a customer's order is placed.",
    defaultEnabled: false,
  },
  {
    timelineType: 'CONFIRMED',
    settingKey: 'notify_evt_order_confirmed',
    label: 'Order confirmed',
    description: 'Sent when the store confirms the order.',
    defaultEnabled: true,
  },
  {
    timelineType: 'PREPARING',
    settingKey: 'notify_evt_order_preparing',
    label: 'Order being prepared',
    description: 'Sent when the order starts being prepared.',
    defaultEnabled: false,
  },
  {
    timelineType: 'PACKED',
    settingKey: 'notify_evt_order_packed',
    label: 'Order packed',
    description: 'Sent when the order is packed and ready for pickup.',
    defaultEnabled: false,
  },
  {
    timelineType: 'RIDER_ACCEPTED',
    settingKey: 'notify_evt_rider_accepted',
    label: 'Rider accepted order',
    description: 'Sent when a delivery partner accepts the order.',
    defaultEnabled: false,
  },
  {
    timelineType: 'PICKED_UP',
    settingKey: 'notify_evt_out_for_delivery',
    label: 'Out for delivery',
    description: 'Sent when the order leaves for delivery.',
    defaultEnabled: true,
  },
  {
    timelineType: 'OTP_RESENT',
    settingKey: 'notify_evt_otp_resent',
    label: 'Delivery OTP resent',
    description: 'Sent when the delivery OTP is resent to the customer.',
    defaultEnabled: true,
  },
  {
    timelineType: 'DELIVERED',
    settingKey: 'notify_evt_delivered',
    label: 'Order delivered',
    description: 'Sent when the order is marked delivered.',
    defaultEnabled: true,
  },
  {
    timelineType: 'CANCELLED',
    settingKey: 'notify_evt_cancelled',
    label: 'Order cancelled',
    description: 'Sent when the order is cancelled.',
    defaultEnabled: true,
  },
  {
    timelineType: 'REFUNDED',
    settingKey: 'notify_evt_refunded',
    label: 'Refund processed',
    description: 'Sent when a refund is processed for the order.',
    defaultEnabled: true,
  },
]

const EVENT_BY_TIMELINE_TYPE = new Map(
  ORDER_NOTIFICATION_EVENTS.map((event) => [event.timelineType, event])
)

export const ORDER_NOTIFICATION_SETTING_KEYS = new Set(
  ORDER_NOTIFICATION_EVENTS.map((event) => event.settingKey)
)

// Short-lived cache so a hot path (every order status change, potentially
// many per minute during peak hours) doesn't hit app_settings on every
// single notification. Explicitly invalidated by admin.service.js right
// after a dashboard save touches one of these keys, so an admin toggle
// takes effect on the very next notification rather than waiting out the
// TTL — the TTL below only matters as a safety net if invalidation is ever
// missed.
const CACHE_TTL_MS = 15_000
let cachedSettings = null
let cachedAt = 0

async function loadSettings() {
  const keys = Array.from(ORDER_NOTIFICATION_SETTING_KEYS)
  const { rows } = await query(
    'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
    [keys]
  )
  const map = new Map(rows.map((row) => [row.key, row.value]))
  cachedSettings = map
  cachedAt = Date.now()
  return map
}

export function invalidateOrderNotificationSettingsCache() {
  cachedSettings = null
  cachedAt = 0
}

/**
 * Whether the customer-facing notification for this order-lifecycle event
 * should actually be sent, per the admin's Settings → Order Notifications
 * toggles. Unknown/legacy timeline types (no entry in the registry above)
 * are always enabled — this only gates the events admins can see and
 * control on the dashboard.
 */
export async function isOrderEventNotificationEnabled(timelineType) {
  const event = EVENT_BY_TIMELINE_TYPE.get(`${timelineType || ''}`.trim().toUpperCase())
  if (!event) {
    return true
  }

  try {
    const isStale = !cachedSettings || Date.now() - cachedAt > CACHE_TTL_MS
    const settings = isStale ? await loadSettings() : cachedSettings
    const storedValue = settings.get(event.settingKey)
    return storedValue === undefined ? event.defaultEnabled : storedValue === true
  } catch (err) {
    // Fail open on the documented default rather than silently dropping a
    // notification because app_settings was briefly unreachable.
    logger.error({ err, timelineType }, 'Failed to read order notification setting; using default')
    return event.defaultEnabled
  }
}

/**
 * Every event's current enabled/disabled flag, keyed by timelineType —
 * consumed by the public GET /notifications/event-flags route so the
 * customer app can keep its own order-status UI (the home-screen top
 * tracking banner) in sync with the same toggles that gate the push/in-app
 * notification, instead of the banner announcing a status change the
 * notification was told to stay quiet about.
 */
export async function getAllOrderEventFlags() {
  let settings
  try {
    const isStale = !cachedSettings || Date.now() - cachedAt > CACHE_TTL_MS
    settings = isStale ? await loadSettings() : cachedSettings
  } catch (err) {
    logger.error({ err }, 'Failed to read order notification settings; using defaults')
    settings = new Map()
  }

  const flags = {}
  for (const event of ORDER_NOTIFICATION_EVENTS) {
    const storedValue = settings.get(event.settingKey)
    flags[event.timelineType] = storedValue === undefined ? event.defaultEnabled : storedValue === true
  }
  return flags
}
