-- 101_cart_milestone_reward_percent.sql
--
-- Brings cart_milestones' CASHBACK reward up to parity with payment_offers
-- (cashback_percent/max_cashback): until now a CASHBACK milestone could
-- only ever pay a flat reward_value, with no way to configure "80%
-- cashback, up to ₹50" the way payment_offers already supports. Same
-- convention — when reward_percent is set, it wins over the flat
-- reward_value, capped by the existing max_discount column. Fully
-- additive/backward compatible; existing flat-only milestones are
-- unaffected (reward_percent stays null).

ALTER TABLE cart_milestones
  ADD COLUMN IF NOT EXISTS reward_percent DECIMAL(5,2) DEFAULT NULL;
