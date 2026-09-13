-- 128_b2b_place_order.sql
--
-- "Place Order" — a new B2B-exclusive payment method (payment_method =
-- 'B2B_CREDIT') distinct from the existing exclusive LEDGER method: it
-- draws the order's FULL total from the customer's B2B credit line
-- immediately (allowed to overdraw past monthly_credit_limit as overage,
-- same soft-cap philosophy as the original ledger design — see migration
-- 121's header), but unlike every other payment method:
--
--   1. It never auto-confirms or queues rider auto-assignment — an admin
--      must explicitly approve it first (see b2b_approval_status below).
--      Admin distributes B2B deliveries manually; the rider-assignment
--      system is irrelevant to these orders.
--   2. Stock is NOT deducted at order placement — it's deferred to the
--      moment an admin approves (see OrderSplitterService#createOrders'
--      new deferStockDeduction option and
--      ShopProductsRepository#deductStockForApprovedOrder). This avoids
--      reserving inventory against an order that's still awaiting a human
--      sanity check.
--   3. Settlement (how the customer actually paid — cash, online transfer,
--      etc.) is recorded manually by an admin after delivery, potentially
--      across multiple partial entries over time, each of which repays the
--      ledger by that amount (order_b2b_settlements below).

-- NULL for every order that isn't a "Place Order" B2B order (the
-- overwhelming majority). 'PENDING' the instant one is created; 'APPROVED'
-- once an admin approves it — at which point stock is deducted and the
-- order proceeds through the normal status lifecycle like any other order.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS b2b_approval_status VARCHAR(20)
    CHECK (b2b_approval_status IN ('PENDING', 'APPROVED'));
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS b2b_approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS b2b_approved_at TIMESTAMPTZ;
-- Running total of order_b2b_settlements recorded against this order —
-- denormalized so the B2B Orders list can show "settled ₹X of ₹Y" without
-- a join+SUM per row. Updated transactionally alongside each settlement
-- insert (see AdminOrdersService#recordB2BSettlement).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS b2b_amount_settled DECIMAL(10,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_b2b_approval_status
  ON orders(b2b_approval_status) WHERE b2b_approval_status IS NOT NULL;

-- Append-only log of manual payment-collection entries an admin records
-- against a "Place Order" order after delivery (e.g. ₹200 cash + ₹500
-- online for a ₹700 order, entered as two separate rows over time). Each
-- entry immediately repays the ledger by its amount (real accounts-
-- receivable, not just a note) — see LedgerService#repayForUser.
CREATE TABLE IF NOT EXISTS order_b2b_settlements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method       VARCHAR(20) NOT NULL CHECK (method IN ('CASH', 'ONLINE', 'OTHER')),
  amount       DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  note         TEXT,
  recorded_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_b2b_settlements_order
  ON order_b2b_settlements(order_id, created_at DESC);
