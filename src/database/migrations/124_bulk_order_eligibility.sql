-- 124_bulk_order_eligibility.sql
-- Per-shop-listing toggle for whether a product can be included in a bulk
-- order at that shop. Defaults to true so every existing shop_products row
-- (and every row inserted before the dashboard exposes the toggle) keeps
-- today's behavior — bulk orders currently accept any listed, available,
-- in-stock product with no per-product exclusion at all.
ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS bulk_order_eligible BOOLEAN NOT NULL DEFAULT true;
