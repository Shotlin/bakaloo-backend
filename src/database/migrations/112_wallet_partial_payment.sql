-- 112_wallet_partial_payment.sql
-- Supports the checkout wallet-balance toggle: wallet balance can now
-- partially or fully offset an order's total_amount regardless of the
-- chosen payment method (COD or ONLINE), rather than requiring the
-- customer to pay for the entire order from the wallet as a separate
-- exclusive payment method. wallet_amount_used records the amount of
-- total_amount that was (or, for a pending ONLINE remainder, will be)
-- debited from the wallet — decided once at order creation and never
-- changed afterward. See PaymentsService.completeVerifiedPayment and
-- OrdersService.placeOrder for how it's set and consumed.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS wallet_amount_used DECIMAL(10,2) NOT NULL DEFAULT 0;
