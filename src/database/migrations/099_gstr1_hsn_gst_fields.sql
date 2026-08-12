-- 099_gstr1_hsn_gst_fields.sql
-- HSN/UQC/per-product GST rate on products, plus order_items snapshot
-- columns, so the GSTR-1 HSN Summary report has something to group by and
-- stays historically accurate even if a product's HSN/rate changes later.
--
-- These columns are for GSTR-1 REPORTING only. They do not affect checkout
-- pricing — TotalsEngine (src/modules/cart/totals-engine.service.js) still
-- charges one flat order-level rate from fee_settings.gst_rate. B2CS reads
-- that real charged rate from orders.fee_breakdown; HSN Summary is a
-- notional per-item allocation using these columns, and the two will not
-- always reconcile to the same total tax (see gstr1.repository.js).
--
-- NOTE: this file is written but not executed as part of this change —
-- applying it (npm run db:migrate) needs a separate explicit go-ahead.

ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(8);
ALTER TABLE products ADD COLUMN IF NOT EXISTS uqc VARCHAR(10);
ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(5,2)
  CONSTRAINT chk_products_gst_rate CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 100));

COMMENT ON COLUMN products.hsn_code IS 'GST HSN/SAC code. Nullable -- unset products bucket as UNKNOWN in the GSTR-1 HSN Summary until an admin fills it in.';
COMMENT ON COLUMN products.uqc IS 'GST-standard Unit Quantity Code (KGS/GMS/LTR/NOS/...). Nullable -- report derives a default from products.unit when unset.';
COMMENT ON COLUMN products.gst_rate IS 'Per-product GST rate (%) override for GSTR-1 reporting only. NULL falls back to fee_settings.gst_rate (GLOBAL). Does NOT affect checkout pricing.';

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS hsn_code_snapshot VARCHAR(8);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS gst_rate_snapshot DECIMAL(5,2);

COMMENT ON COLUMN order_items.hsn_code_snapshot IS 'products.hsn_code at order time. NULL on rows created before this migration, or where the product had no hsn_code set yet -- report falls back to joining current products.hsn_code (an approximation for historical data).';
COMMENT ON COLUMN order_items.gst_rate_snapshot IS 'Effective GST rate (%) resolved at order time (product override, else GLOBAL fee_settings.gst_rate at that moment). NULL on legacy rows -- report falls back to COALESCE(current products.gst_rate, current GLOBAL fee_settings.gst_rate, 0).';

-- No index added for orders.delivery_address->>'state' grouping (used by
-- the B2CS query) -- this report runs at most a handful of times a month,
-- and getGeographicAnalytics() already groups by a JSONB field unindexed
-- at current order volume. Revisit with:
--   CREATE INDEX IF NOT EXISTS idx_orders_delivery_state ON orders ((delivery_address->>'state'));
-- if this ever becomes slow.
