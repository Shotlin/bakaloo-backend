-- 130_bulk_order_min_qty_and_window.sql
--
-- Extends the bulk-order eligibility gate added by 124_bulk_order_eligibility.sql
-- (a flat on/off `bulk_order_eligible` boolean) with two more per-listing rules
-- an admin can configure alongside it:
--
--   1. bulk_min_quantity — the minimum quantity of THIS listing a bulk order
--      line must request to qualify (e.g. "at least 10 pieces" / "at least
--      5 units of this 1kg pack"). NULL means no minimum beyond the
--      whole-order minimum bulk_orders already enforces (>=5 total items,
--      >=3 distinct products — see 037_bulk_orders.sql).
--   2. bulk_sale_start_at / bulk_sale_end_at — an optional time window
--      during which this listing is actually eligible for bulk ordering
--      (a "bulk sale" period). NULL on either side means unbounded on that
--      side; both NULL (the default) means always eligible whenever the
--      bulk_order_eligible toggle itself is on — i.e. this migration
--      changes nothing about existing listings until an admin sets values.

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS bulk_min_quantity INTEGER;

ALTER TABLE shop_products
  ADD CONSTRAINT chk_shop_products_bulk_min_quantity
    CHECK (bulk_min_quantity IS NULL OR bulk_min_quantity >= 1);

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS bulk_sale_start_at TIMESTAMPTZ;

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS bulk_sale_end_at TIMESTAMPTZ;

ALTER TABLE shop_products
  ADD CONSTRAINT chk_shop_products_bulk_sale_window
    CHECK (
      bulk_sale_start_at IS NULL
      OR bulk_sale_end_at IS NULL
      OR bulk_sale_end_at > bulk_sale_start_at
    );
