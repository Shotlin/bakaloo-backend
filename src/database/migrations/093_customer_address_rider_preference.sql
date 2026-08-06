-- 093_customer_address_rider_preference.sql
-- Sticky rider-per-address memory: whichever rider an admin last assigned
-- for a customer's delivery to a given saved address, surfaced back as a
-- suggestion (not an automatic dispatch override) next time an order to
-- that same address reaches PACKED.

CREATE TABLE IF NOT EXISTS customer_address_rider_preferences (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  address_id  UUID REFERENCES addresses(id) ON DELETE CASCADE NOT NULL,
  rider_id    UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, address_id)
);

CREATE INDEX IF NOT EXISTS idx_carp_user_address ON customer_address_rider_preferences(user_id, address_id);
