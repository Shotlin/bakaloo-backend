-- 103_cart_milestone_scope.sql
--
-- Brings cart_milestones up to parity with coupons' and first_time_offers'
-- category/product scoping (090_first_time_offer_scope_and_free_delivery.sql,
-- which itself mirrored coupons' pre-existing applicable_category_ids /
-- applicable_product_ids columns):
--
-- applicable_category_ids / applicable_product_ids — lets an admin restrict
-- a cart milestone to specific categories/bundles/products, exactly like a
-- scoped coupon or first-time offer. NULL (the default) means "whole cart",
-- identical to today's unscoped behavior — fully additive.
--
-- Fully additive: new nullable columns only, no impact on existing cart
-- milestones or the checkout flow for unscoped ones.

ALTER TABLE cart_milestones
  ADD COLUMN IF NOT EXISTS applicable_category_ids UUID[],
  ADD COLUMN IF NOT EXISTS applicable_product_ids UUID[];
