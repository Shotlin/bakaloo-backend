-- 096_order_pickup_tokens.sql
--
-- QR pickup tokens — one row per "live" pickup credential for an order.
-- Phase A only mints these (see finalize-assignment.service.js); signing,
-- the rider-facing verify-scan endpoint, and invoice embedding are a
-- later phase. Minting the row now means the invalidation rules ("QR must
-- become invalid when rider assignment changes") already hold structurally
-- before any of that is built: reassignment revokes the old row and mints
-- a fresh one bound to the new delivery_assignment_id.

CREATE TABLE IF NOT EXISTS order_pickup_tokens (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id                 UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  delivery_assignment_id   UUID REFERENCES delivery_assignments(id) ON DELETE CASCADE,
  token                    VARCHAR(64) UNIQUE NOT NULL,
  version                  INTEGER NOT NULL DEFAULT 1,
  status                   VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  issued_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ,
  verified_at              TIMESTAMPTZ,
  verified_by_rider_id     UUID REFERENCES users(id),
  consumed_at              TIMESTAMPTZ,
  revoked_at               TIMESTAMPTZ,
  revoked_reason           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_pickup_tokens_status'
  ) THEN
    ALTER TABLE order_pickup_tokens
      ADD CONSTRAINT chk_order_pickup_tokens_status
      CHECK (status IN ('ACTIVE', 'VERIFIED', 'CONSUMED', 'REVOKED', 'EXPIRED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_order_pickup_tokens_order ON order_pickup_tokens(order_id);
CREATE INDEX IF NOT EXISTS idx_order_pickup_tokens_assignment ON order_pickup_tokens(delivery_assignment_id);
-- Fast "does this order have a currently-active token" lookup.
CREATE INDEX IF NOT EXISTS idx_order_pickup_tokens_active ON order_pickup_tokens(order_id) WHERE status = 'ACTIVE';
