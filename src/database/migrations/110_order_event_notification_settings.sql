-- 110_order_event_notification_settings.sql
-- Per-event on/off switches for the customer push/in-app notifications that
-- fire as an order moves through its lifecycle (see
-- src/modules/notifications/order-notification-settings.js, which reads
-- these through the existing generic app_settings table — no new table
-- needed). Surfaced as toggles under Settings → Order Notifications in the
-- dashboard.
--
-- Four of these are seeded OFF: reported feedback that customers were
-- getting hit with a notification on every single status step (placed,
-- preparing, packed, rider accepted — four banners before the order has
-- even left the store) was excessive. Order confirmed, out for delivery,
-- delivered, cancelled, refunded, and OTP-resent stay ON since those are
-- the events a customer actually needs to see.
--
-- ON CONFLICT DO NOTHING so re-running this never clobbers a value an
-- admin has already changed via the dashboard.

INSERT INTO app_settings (key, value, description) VALUES
  ('notify_evt_order_placed',    'false', 'Send a notification when a customer''s order is placed'),
  ('notify_evt_order_confirmed', 'true',  'Send a notification when an order is confirmed'),
  ('notify_evt_order_preparing', 'false', 'Send a notification when an order starts being prepared'),
  ('notify_evt_order_packed',    'false', 'Send a notification when an order is packed'),
  ('notify_evt_rider_accepted',  'false', 'Send a notification when a rider accepts an order'),
  ('notify_evt_out_for_delivery','true',  'Send a notification when an order is out for delivery'),
  ('notify_evt_otp_resent',      'true',  'Send a notification when a delivery OTP is resent'),
  ('notify_evt_delivered',       'true',  'Send a notification when an order is delivered'),
  ('notify_evt_cancelled',       'true',  'Send a notification when an order is cancelled'),
  ('notify_evt_refunded',        'true',  'Send a notification when a refund is processed')
ON CONFLICT (key) DO NOTHING;
