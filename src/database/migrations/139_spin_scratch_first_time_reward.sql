-- 139_spin_scratch_first_time_reward.sql
--
-- Guaranteed first-time reward for Spin & Win and Scratch Card: a user's
-- very FIRST spin ever (spin_history has no prior row for them) and,
-- separately, their very first scratch ever, always resolves to a real
-- prize — never BETTER_LUCK — drawn from its own small admin-configured
-- pool instead of the normal odds. Every spin/scratch after that first one
-- uses the normal pool exactly as before, regardless of whether the user
-- has placed an order (order history plays no part in this at all — see
-- spin-wheel.service.js#spin / scratch-card.service.js#scratch). Tracked
-- independently per game: a user's first spin and first scratch each get
-- their own one-time guaranteed resolution.
--
-- spin_first_time_prizes / scratch_first_time_prizes — same shape as
-- spin_prizes/scratch_prizes but BETTER_LUCK is not a legal type here (the
-- whole point is a guaranteed win), enforced by the type CHECK below.
-- first_time_reward_enabled on each settings singleton lets an admin turn
-- the whole mechanic off (falls back to normal odds for every spin/scratch,
-- first-ever or not). is_first_time_reward on each history table records
-- which resolutions came from this pool, for admin visibility.
--
-- Fully additive: new tables/columns only, no impact on existing flows.

CREATE TABLE IF NOT EXISTS spin_first_time_prizes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              VARCHAR(20) NOT NULL,
  icon_key          VARCHAR(30) NOT NULL DEFAULT 'gift',
  label             VARCHAR(50) NOT NULL,
  value             DECIMAL(10,2),
  win_probability   DECIMAL(5,2) NOT NULL DEFAULT 0,
  display_order     INT NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  -- Required (enforced in the service layer) for every type — same rule as
  -- spin_prizes, minus the BETTER_LUCK exemption since it can't appear here.
  linked_coupon_id  UUID REFERENCES coupons(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_spin_first_time_prizes_type CHECK (type IN
    ('FREE_DELIVERY', 'PERCENTAGE_OFF', 'FLAT_OFF', 'BUY_ONE_GET_ONE', 'CASHBACK')),
  CONSTRAINT chk_spin_first_time_prizes_icon_key CHECK (icon_key IN
    ('shopping_cart', 'percent', 'basket', 'coins', 'gift', 'sad_face', 'star', 'ticket')),
  CONSTRAINT chk_spin_first_time_prizes_probability CHECK (win_probability >= 0 AND win_probability <= 100)
);

CREATE INDEX IF NOT EXISTS idx_spin_first_time_prizes_active ON spin_first_time_prizes(is_active, display_order);

CREATE TABLE IF NOT EXISTS scratch_first_time_prizes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              VARCHAR(20) NOT NULL,
  icon_key          VARCHAR(30) NOT NULL DEFAULT 'gift',
  label             VARCHAR(50) NOT NULL,
  value             DECIMAL(10,2),
  win_probability   DECIMAL(5,2) NOT NULL DEFAULT 0,
  display_order     INT NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  linked_coupon_id  UUID REFERENCES coupons(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_scratch_first_time_prizes_type CHECK (type IN
    ('FREE_DELIVERY', 'PERCENTAGE_OFF', 'FLAT_OFF', 'BUY_ONE_GET_ONE', 'CASHBACK')),
  CONSTRAINT chk_scratch_first_time_prizes_icon_key CHECK (icon_key IN
    ('shopping_cart', 'percent', 'basket', 'coins', 'gift', 'sad_face', 'star', 'ticket')),
  CONSTRAINT chk_scratch_first_time_prizes_probability CHECK (win_probability >= 0 AND win_probability <= 100)
);

CREATE INDEX IF NOT EXISTS idx_scratch_first_time_prizes_active ON scratch_first_time_prizes(is_active, display_order);

ALTER TABLE spin_wheel_settings
  ADD COLUMN IF NOT EXISTS first_time_reward_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE scratch_card_settings
  ADD COLUMN IF NOT EXISTS first_time_reward_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE spin_history
  ADD COLUMN IF NOT EXISTS is_first_time_reward BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE scratch_history
  ADD COLUMN IF NOT EXISTS is_first_time_reward BOOLEAN NOT NULL DEFAULT false;

-- Seed: one no-coupon-needed guaranteed prize each (100% probability, single
-- active row) — safe to go live immediately, same spirit as migrations
-- 118/137's own seed prizes.
INSERT INTO spin_first_time_prizes (type, icon_key, label, value, win_probability, display_order, is_active)
SELECT 'CASHBACK', 'star', 'Welcome Gift', 25::decimal, 100.00::decimal, 1, true
WHERE NOT EXISTS (SELECT 1 FROM spin_first_time_prizes);

INSERT INTO scratch_first_time_prizes (type, icon_key, label, value, win_probability, display_order, is_active)
SELECT 'CASHBACK', 'star', 'Welcome Gift', 25::decimal, 100.00::decimal, 1, true
WHERE NOT EXISTS (SELECT 1 FROM scratch_first_time_prizes);
