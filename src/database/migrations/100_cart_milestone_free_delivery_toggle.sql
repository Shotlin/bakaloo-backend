-- 100_cart_milestone_free_delivery_toggle.sql
--
-- Brings cart_milestones up to parity with coupons/first_time_offers'
-- free-delivery toggle (088_coupon_free_delivery_toggle.sql,
-- 090_first_time_offer_scope_and_free_delivery.sql):
--
-- grants_free_delivery — an independent flag any milestone reward can
-- carry, regardless of reward_type. Until now a milestone could only ever
-- waive delivery by... it couldn't, there was no FREE_DELIVERY reward_type
-- for milestones at all. This lets an admin build e.g. "spend ₹500, get
-- free delivery" on a CASHBACK or FLAT_DISCOUNT milestone, without
-- inventing a fake reward value. Fully additive/backward compatible.

ALTER TABLE cart_milestones
  ADD COLUMN IF NOT EXISTS grants_free_delivery BOOLEAN NOT NULL DEFAULT false;
