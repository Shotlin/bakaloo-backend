-- 118_spin_wheel_core.sql
--
-- Spin & Win phase 2: server-authoritative prize wheel.
--
-- spin_prizes           — admin-configured wedges (2-8 active at a time,
--                         enforced in the service layer, not here).
-- spin_wheel_settings   — singleton: daily free-spin count + popup trigger
--                         mode (ALWAYS_ON_LOGIN | MILESTONE_ONLY | MANUAL_ONLY).
-- spin_milestone_rules  — admin-defined order-count/spend thresholds that
--                         grant bonus spins.
-- user_spin_wallet      — one row per user, running spin balance.
-- spin_credit_grants    — audit ledger of every credit granted (daily/
--                         milestone/admin) — also used to dedupe one-time
--                         milestone grants.
-- spin_history          — one row per spin, snapshots the prize won so
--                         history survives later prize edits/deletes.
--
-- Reward issuance itself reuses existing systems — coupon_target_users via
-- spin_prizes.linked_coupon_id (same mechanism cart_milestones/
-- first_time_offers already use), wallet_transactions via the existing,
-- previously-unused sub_type='SCRATCH' (068_first_time_offers_and_cashback.sql).
-- No new discount engine, no new wallet columns.
--
-- Fully additive: new tables only, no impact on existing flows.

CREATE TABLE IF NOT EXISTS spin_prizes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              VARCHAR(20) NOT NULL,
  icon_key          VARCHAR(30) NOT NULL DEFAULT 'gift',
  label             VARCHAR(50) NOT NULL,
  value             DECIMAL(10,2),
  win_probability   DECIMAL(5,2) NOT NULL DEFAULT 0,
  display_order     INT NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  -- Required (enforced in the service layer) for every type except
  -- BETTER_LUCK — the linked coupon's own discount_type/value is what
  -- actually executes at checkout; this table only decides the wheel's
  -- odds and label/icon.
  linked_coupon_id  UUID REFERENCES coupons(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_spin_prizes_type CHECK (type IN
    ('FREE_DELIVERY', 'PERCENTAGE_OFF', 'FLAT_OFF', 'BUY_ONE_GET_ONE', 'CASHBACK', 'BETTER_LUCK')),
  CONSTRAINT chk_spin_prizes_icon_key CHECK (icon_key IN
    ('shopping_cart', 'percent', 'basket', 'coins', 'gift', 'sad_face', 'star', 'ticket')),
  CONSTRAINT chk_spin_prizes_probability CHECK (win_probability >= 0 AND win_probability <= 100)
);

CREATE INDEX IF NOT EXISTS idx_spin_prizes_active ON spin_prizes(is_active, display_order);

CREATE TABLE IF NOT EXISTS spin_wheel_settings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_free_spins  INT NOT NULL DEFAULT 1 CHECK (daily_free_spins >= 0),
  trigger_mode      VARCHAR(20) NOT NULL DEFAULT 'ALWAYS_ON_LOGIN',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_spin_wheel_settings_trigger CHECK (trigger_mode IN
    ('ALWAYS_ON_LOGIN', 'MILESTONE_ONLY', 'MANUAL_ONLY'))
);
-- Singleton enforcement — same partial-unique-index idiom as app_themes'
-- idx_one_active_theme (020_app_themes.sql).
CREATE UNIQUE INDEX IF NOT EXISTS idx_spin_wheel_settings_singleton ON spin_wheel_settings ((true));

CREATE TABLE IF NOT EXISTS spin_milestone_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_type VARCHAR(20) NOT NULL,
  threshold      DECIMAL(10,2) NOT NULL CHECK (threshold > 0),
  bonus_spins    INT NOT NULL DEFAULT 1 CHECK (bonus_spins > 0),
  is_repeating   BOOLEAN NOT NULL DEFAULT false,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_spin_milestone_type CHECK (milestone_type IN ('ORDER_COUNT', 'TOTAL_SPEND'))
);

CREATE INDEX IF NOT EXISTS idx_spin_milestone_rules_active ON spin_milestone_rules(is_active);

CREATE TABLE IF NOT EXISTS user_spin_wallet (
  user_id               UUID PRIMARY KEY REFERENCES users(id),
  available_spins       INT NOT NULL DEFAULT 0 CHECK (available_spins >= 0),
  last_daily_grant_date DATE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spin_credit_grants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  amount      INT NOT NULL CHECK (amount > 0),
  source      VARCHAR(20) NOT NULL,
  -- Milestone rule id for MILESTONE grants (dedupe key for one-time rules);
  -- granting admin's own user id, string-cast, for ADMIN grants; NULL for DAILY.
  source_ref  TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_spin_credit_grants_source CHECK (source IN ('DAILY', 'MILESTONE', 'ADMIN'))
);

CREATE INDEX IF NOT EXISTS idx_spin_credit_grants_dedup ON spin_credit_grants(source, source_ref, user_id);
CREATE INDEX IF NOT EXISTS idx_spin_credit_grants_user ON spin_credit_grants(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS spin_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  prize_id      UUID REFERENCES spin_prizes(id) ON DELETE SET NULL,
  prize_type    VARCHAR(20) NOT NULL,
  prize_label   VARCHAR(50) NOT NULL,
  prize_value   DECIMAL(10,2),
  is_win        BOOLEAN NOT NULL,
  reward_status VARCHAR(10) NOT NULL DEFAULT 'N_A',
  -- Coupon id (FREE_DELIVERY/PERCENTAGE_OFF/FLAT_OFF/BUY_ONE_GET_ONE) or
  -- wallet_transactions.id (CASHBACK); NULL for BETTER_LUCK or a FAILED issuance.
  reward_ref    TEXT,
  spun_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_spin_history_reward_status CHECK (reward_status IN ('ISSUED', 'FAILED', 'N_A'))
);

CREATE INDEX IF NOT EXISTS idx_spin_history_user ON spin_history(user_id, spun_at DESC);

-- Seed: singleton settings row.
INSERT INTO spin_wheel_settings (daily_free_spins, trigger_mode)
SELECT 1, 'ALWAYS_ON_LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM spin_wheel_settings);

-- Seed: 2 prizes that need no linked coupon at all (safe to go live
-- immediately, sums to 100%), plus 6 inactive templates the admin
-- activates after linking a real coupon from the existing Coupons page.
-- See spin-wheel.service.js's prize-save validation for why a
-- coupon-requiring type can't be activated without one.
INSERT INTO spin_prizes (type, icon_key, label, value, win_probability, display_order, is_active)
SELECT * FROM (VALUES
  ('CASHBACK',        'star',          'Extra Savings',         20::decimal,  30.00::decimal, 1, true),
  ('BETTER_LUCK',      'sad_face',      'Better Luck Next Time', NULL::decimal, 70.00::decimal, 2, true),
  ('FREE_DELIVERY',    'shopping_cart', 'Free Delivery',         NULL::decimal, 0::decimal,     3, false),
  ('PERCENTAGE_OFF',   'percent',       '5% OFF',                5::decimal,   0::decimal,     4, false),
  ('PERCENTAGE_OFF',   'basket',        '10% OFF',               10::decimal,  0::decimal,     5, false),
  ('FLAT_OFF',         'coins',         '₹50 OFF',               50::decimal,  0::decimal,     6, false),
  ('FLAT_OFF',         'gift',          '₹100 OFF',              100::decimal, 0::decimal,     7, false),
  ('BUY_ONE_GET_ONE',  'gift',          'BUY 1 GET 1',           NULL::decimal, 0::decimal,     8, false)
) AS seed(type, icon_key, label, value, win_probability, display_order, is_active)
WHERE NOT EXISTS (SELECT 1 FROM spin_prizes);
