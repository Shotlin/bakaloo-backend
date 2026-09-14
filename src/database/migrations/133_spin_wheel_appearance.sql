-- 133_spin_wheel_appearance.sql
--
-- Spin & Win popup appearance: dashboard-configurable background image and
-- banner-box copy (the small "Win up to ₹100 off / on your next order /
-- Good Deals Everyday!" box under the wheel). Both were previously
-- hardcoded client-side in the Flutter app (bundled asset + literal
-- strings) — this makes them editable from the existing Spin & Win →
-- Settings tab, alongside daily_free_spins/trigger_mode.
--
-- background_image_url / background_image_public_id are both nullable —
-- NULL means "no custom image uploaded yet", in which case the app keeps
-- using its bundled default asset. public_id is stored separately from the
-- delivery url so a future re-upload can cloudinary.uploader.destroy() the
-- previous asset before replacing it (same reason products/banners keep a
-- public_id around).
--
-- banner_title/subtitle/tagline default to the exact copy already hardcoded
-- in spin_win_dialog.dart, so existing behavior is unchanged until an admin
-- actually edits them from the dashboard.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, matching every prior migration in
-- this file's style (e.g. 033_orders_shop_id.sql, 094_rider_shop_capacity_
-- fairness.sql).

ALTER TABLE spin_wheel_settings
  ADD COLUMN IF NOT EXISTS background_image_url TEXT,
  ADD COLUMN IF NOT EXISTS background_image_public_id TEXT,
  ADD COLUMN IF NOT EXISTS banner_title TEXT NOT NULL DEFAULT 'Win up to ₹100 off',
  ADD COLUMN IF NOT EXISTS banner_subtitle TEXT NOT NULL DEFAULT 'on your next order',
  ADD COLUMN IF NOT EXISTS banner_tagline TEXT NOT NULL DEFAULT ('Good Deals' || chr(10) || 'Everyday!');
