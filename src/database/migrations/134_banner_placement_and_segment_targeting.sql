-- 134_banner_placement_and_segment_targeting.sql
--
-- Extends the existing banners table (015_admin_dashboard.sql, plus
-- 073_banner_triggers.sql's trigger_type and 123_theme_and_banner_audience.sql's
-- audience) with the two dimensions it was missing for a profile-screen
-- banner placement:
--
--   1. placement — WHICH screen this banner renders on. Every existing row
--      defaults to 'HOME' (today's only consumer, section_registry.dart's
--      home section-builder), so this migration changes no current
--      behavior. 'PROFILE' is the new placement this feature adds.
--   2. target_segment_id — optional targeting to one customer_segments
--      group (customer_segments/customer_segment_members already exist —
--      067_customer_segments_and_coupon_targeting.sql — and are already
--      used this same way by coupons.target_segment_id and
--      cart_milestones.applicable_segment_id). NULL means "every customer
--      in the resolved audience", same as those two features' convention.
--   3. image_width / image_height — the pixel dimensions an admin declares
--      for the banner, so the dashboard can validate an uploaded image
--      against the intended slot size before publishing, instead of the
--      app discovering a wrong aspect ratio live in production.
--
-- audience (B2C/B2B/ALL, from 123) is intentionally left untouched and
-- reused as-is: it already gives one banner system that serves both B2B
-- and B2C from the same table and the same admin flow, which is the
-- explicit requirement here — not a parallel B2B-only or B2C-only system.

ALTER TABLE banners
  ADD COLUMN IF NOT EXISTS placement VARCHAR(20) NOT NULL DEFAULT 'HOME';

ALTER TABLE banners
  ADD CONSTRAINT chk_banners_placement
    CHECK (placement IN ('HOME', 'PROFILE'));

ALTER TABLE banners
  ADD COLUMN IF NOT EXISTS target_segment_id UUID
    REFERENCES customer_segments(id) ON DELETE SET NULL;

ALTER TABLE banners
  ADD COLUMN IF NOT EXISTS image_width INTEGER;

ALTER TABLE banners
  ADD COLUMN IF NOT EXISTS image_height INTEGER;

ALTER TABLE banners
  ADD CONSTRAINT chk_banners_image_width
    CHECK (image_width IS NULL OR image_width > 0);

ALTER TABLE banners
  ADD CONSTRAINT chk_banners_image_height
    CHECK (image_height IS NULL OR image_height > 0);

-- Every customer-facing banner fetch filters is_active + placement together
-- (see findActiveForStoreStatus) — a partial index on the hot path only.
CREATE INDEX IF NOT EXISTS idx_banners_placement_active
  ON banners(placement) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_banners_target_segment_id
  ON banners(target_segment_id) WHERE target_segment_id IS NOT NULL;
