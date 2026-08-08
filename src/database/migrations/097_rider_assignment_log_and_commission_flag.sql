-- 097_rider_assignment_log_and_commission_flag.sql
--
-- 1. rider_assignment_log — one row per resolver decision (including "no
--    eligible rider"), satisfying "log which rule selected the final
--    rider" for area-segment conflicts and general auditability of every
--    manual/segment/auto assignment.
-- 2. rider_commission_enabled — global feature flag, seeded false. Riders
--    are moving to salary-based pay; this flag gates all new commission
--    writes (rider_earnings inserts, delivery_assignments.earnings
--    updates, "Earn ₹X" push copy) without touching historical records or
--    dropping any commission schema.

CREATE TABLE IF NOT EXISTS rider_assignment_log (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  rider_id     UUID REFERENCES users(id),
  method       VARCHAR(20) NOT NULL,
  reason       TEXT,
  triggered_by VARCHAR(100),
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_rider_assignment_log_method'
  ) THEN
    ALTER TABLE rider_assignment_log
      ADD CONSTRAINT chk_rider_assignment_log_method
      CHECK (method IN ('MANUAL', 'AREA_SEGMENT', 'AUTO', 'NONE'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rider_assignment_log_order ON rider_assignment_log(order_id);
CREATE INDEX IF NOT EXISTS idx_rider_assignment_log_rider ON rider_assignment_log(rider_id);

INSERT INTO app_settings (key, value, description)
VALUES ('rider_commission_enabled', 'false', 'Whether new rider commission/earnings are calculated and credited. Riders are salary-based; historical records are unaffected by this flag.')
ON CONFLICT (key) DO NOTHING;
