-- 095_area_segments.sql
--
-- Area Segments — admin-defined geographic/route zones, each with one
-- assigned rider, covering a set of exact customer+saved-address pairs
-- (never "this customer" alone). Structurally mirrors customer_segments
-- (067_customer_segments_and_coupon_targeting.sql), but the membership
-- grain is (customer, exact address) rather than just customer, since a
-- segment rider assignment must NOT apply when the same customer orders to
-- a different saved address.

CREATE TABLE IF NOT EXISTS area_segments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  rider_id    UUID REFERENCES users(id),
  priority    INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id),
  updated_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_area_segments_rider ON area_segments(rider_id);
CREATE INDEX IF NOT EXISTS idx_area_segments_active ON area_segments(is_active) WHERE is_active = true;

-- One row per (customer, exact saved address) covered by a segment.
-- address_id is the primary match key (immutable FK into `addresses`);
-- address_fingerprint is a fallback slot only, never the primary lookup —
-- raw address text is user-editable so it can drift.
CREATE TABLE IF NOT EXISTS area_segment_addresses (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  segment_id           UUID NOT NULL REFERENCES area_segments(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_id           UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  address_fingerprint  TEXT,
  lat                  DECIMAL(10,8),
  lng                  DECIMAL(11,8),
  added_by             UUID REFERENCES users(id),
  added_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (segment_id, address_id)
);

-- Deliberately NOT unique on (user_id, address_id) alone — the same exact
-- address can legitimately be registered in more than one active segment
-- (e.g. an admin mistake, or overlapping zone definitions), and the
-- resolver's conflict-resolution rule (priority DESC, created_at ASC) plus
-- audit logging (rider_assignment_log, see 097) needs real conflicts to be
-- detectable rather than silently prevented.
CREATE INDEX IF NOT EXISTS idx_area_segment_addresses_lookup ON area_segment_addresses(user_id, address_id);
CREATE INDEX IF NOT EXISTS idx_area_segment_addresses_segment ON area_segment_addresses(segment_id);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS area_segment_id UUID REFERENCES area_segments(id);
