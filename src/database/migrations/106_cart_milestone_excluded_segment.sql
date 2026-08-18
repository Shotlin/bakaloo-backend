-- 106_cart_milestone_excluded_segment.sql
--
-- Lets an admin exclude one customer segment from an "All users" cart
-- milestone — e.g. a segment that already has its own dedicated,
-- segment-scoped milestone shouldn't also qualify for the general "All
-- users" one, which would otherwise let that segment double-dip on both
-- rewards for the same purchase. Only meaningful when
-- applicable_user_type = 'ALL'; FIRST_TIME/SEGMENT milestones already
-- run their own single-audience rule and ignore this column entirely.
--
-- Fully additive: new nullable column, no impact on existing milestones.

ALTER TABLE cart_milestones
  ADD COLUMN IF NOT EXISTS excluded_segment_id UUID REFERENCES customer_segments(id);
