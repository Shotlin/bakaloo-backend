-- 104_upi_collection.sql
--
-- Rider-collected COD payment tracking: an admin configures the business's
-- UPI ID once (in app_settings, alongside the other payment-method flags
-- from payment-settings), the rider app renders a UPI-pay QR from it at
-- delivery time for COD orders, and the rider records how much the
-- customer paid via UPI vs. cash before completing the delivery.
--
-- Fully additive: new nullable columns + a settings-key seed only. No
-- impact on existing deliveries or non-COD orders (Wallet/Online orders
-- never populate these).

INSERT INTO app_settings (key, value, description)
VALUES (
  'business_upi_id',
  '""'::jsonb,
  'UPI ID (e.g. name@bank) used to generate the payment QR code riders show customers for Cash on Delivery orders'
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE delivery_assignments
  ADD COLUMN IF NOT EXISTS cash_collected DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS upi_collected DECIMAL(10,2);
