-- 094_rider_shop_capacity_fairness.sql
--
-- Foundation columns for the new modular rider-assignment resolver
-- (replaces the old proximity-only auto-assign worker for the
-- CONFIRMED/PREPARING/PACKED-triggered path — that worker's code stays in
-- place, just stops being invoked from order-status transitions).
--
-- 1. rider_profiles.shop_id — no rider<->store association existed at all
--    before this; one primary store per rider, admin-settable.
-- 2. rider_profiles.max_active_orders — per-rider capacity override; NULL
--    means "use the global app_settings default" (seeded below).
-- 3. rider_profiles.last_assigned_at — fairness tie-breaker for the new
--    resolver's tier-3 (general auto) ranking.
-- 4. orders.assignment_method / assigned_at — which tier decided the
--    current rider, and when, surfaced on the admin order card.
-- 5. delivery_assignments.notification_sent_at — dedup guard so a retried
--    finalize never double-pushes the same rider for the same assignment.

ALTER TABLE rider_profiles
  ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id),
  ADD COLUMN IF NOT EXISTS max_active_orders INTEGER,
  ADD COLUMN IF NOT EXISTS last_assigned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_rider_profiles_shop ON rider_profiles(shop_id);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS assignment_method VARCHAR(20),
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_assignment_method'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_assignment_method
      CHECK (assignment_method IS NULL OR assignment_method IN ('MANUAL', 'AREA_SEGMENT', 'AUTO'));
  END IF;
END $$;

ALTER TABLE delivery_assignments
  ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ;

INSERT INTO app_settings (key, value, description)
VALUES ('rider_max_active_orders', '4', 'Default max concurrent active orders per rider (multi-order pickup capacity)')
ON CONFLICT (key) DO NOTHING;
