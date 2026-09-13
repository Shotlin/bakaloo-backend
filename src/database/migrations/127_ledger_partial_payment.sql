-- 127_ledger_partial_payment.sql
-- Ledger-equivalent of 112_wallet_partial_payment.sql: the B2B credit line
-- can now partially or fully offset an order's total_amount (COD or
-- ONLINE), the same way the wallet-balance toggle already does, instead of
-- only being usable via the exclusive full-order LEDGER payment method
-- (LedgerService#payFromLedger). ledger_amount_used records the amount of
-- total_amount that was (or, for a pending ONLINE remainder, will be)
-- drawn from the ledger — decided once at order creation and never changed
-- afterward. See OrdersService#placeOrder and
-- PaymentsService#completeVerifiedPayment for how it's set and consumed.
--
-- Unlike the wallet toggle (which spends the customer's own prepaid
-- money), this draw is real credit — if the order is later cancelled or
-- refunded, it must be reversed (repaid) or the customer is billed for an
-- order they never received. See the reversal added alongside this in
-- orders.service.js (customer self-cancel) and admin/orders/orders.service.js
-- (admin cancel/refund) and admin/refund-requests/refund-requests.service.js.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS ledger_amount_used DECIMAL(10,2) NOT NULL DEFAULT 0;
