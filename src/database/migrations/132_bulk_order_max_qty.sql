-- 132_bulk_order_max_qty.sql
--
-- Companion ceiling to bulk_min_quantity (130_bulk_order_min_qty_and_window.sql):
-- the maximum quantity of THIS listing a single bulk order line may request.
-- NULL means no per-listing ceiling (only the whole-order/global caps apply).
-- Mirrors bulk_min_quantity's own CHECK shape, plus an ordering constraint so
-- a listing can never be saved with max < min.

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS bulk_max_quantity INTEGER;

ALTER TABLE shop_products
  ADD CONSTRAINT chk_shop_products_bulk_max_quantity
    CHECK (bulk_max_quantity IS NULL OR bulk_max_quantity >= 1);

ALTER TABLE shop_products
  ADD CONSTRAINT chk_shop_products_bulk_min_max_order
    CHECK (
      bulk_min_quantity IS NULL
      OR bulk_max_quantity IS NULL
      OR bulk_max_quantity >= bulk_min_quantity
    );
