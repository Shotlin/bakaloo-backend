-- 129_b2b_settlement_methods_and_due_date.sql
--
-- 128_b2b_place_order.sql was already applied to production (tracked by
-- filename in `_migrations`, never re-run) BEFORE it was edited in-place
-- during the B2B ledger-simplification revert to add
-- `b2b_payment_due_date` and broaden `order_b2b_settlements.method` to
-- CASH/UPI/RAZORPAY/OTHER. Editing an already-applied migration file has
-- no effect on a database that already ran it — this migration applies
-- those same two changes for real, as a proper follow-up step.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS b2b_payment_due_date DATE;

-- Postgres has no ALTER CHECK CONSTRAINT — drop and recreate under the
-- same name. The constraint name is the table's default auto-generated
-- one (order_b2b_settlements_method_check) from the original inline
-- column CHECK in 128_b2b_place_order.sql.
ALTER TABLE order_b2b_settlements
  DROP CONSTRAINT IF EXISTS order_b2b_settlements_method_check;
ALTER TABLE order_b2b_settlements
  ADD CONSTRAINT order_b2b_settlements_method_check
    CHECK (method IN ('CASH', 'UPI', 'RAZORPAY', 'OTHER'));
