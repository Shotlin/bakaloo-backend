-- 098_qr_scan_logs.sql
--
-- Every QR pickup scan attempt, success or rejected — item 4's "every scan
-- attempt must be logged with rider id, order id, scan time, verification
-- result, device information, failure reason." token_id/order_id/rider_id
-- are all nullable because a scan can fail before any of those resolve
-- (e.g. a garbage/unparseable payload still needs a log row with a
-- rider_id from the authenticated JWT and everything else null).

CREATE TABLE IF NOT EXISTS qr_scan_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_id        UUID REFERENCES order_pickup_tokens(id),
  order_id        UUID REFERENCES orders(id),
  rider_id        UUID REFERENCES users(id),
  result          VARCHAR(20) NOT NULL,
  failure_reason  TEXT,
  device_info     JSONB,
  ip_address      TEXT,
  scanned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_qr_scan_logs_result'
  ) THEN
    ALTER TABLE qr_scan_logs
      ADD CONSTRAINT chk_qr_scan_logs_result
      CHECK (result IN ('SUCCESS', 'REJECTED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_qr_scan_logs_order ON qr_scan_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_qr_scan_logs_rider ON qr_scan_logs(rider_id);
CREATE INDEX IF NOT EXISTS idx_qr_scan_logs_token ON qr_scan_logs(token_id);
