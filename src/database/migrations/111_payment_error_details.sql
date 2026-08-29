-- 111_payment_error_details.sql
-- Capture Razorpay's decline-reason fields on failed payments, and a
-- generic metadata-driven "needs manual review" flag for payments that
-- were captured after their order had already moved on (e.g. cancelled) —
-- see PaymentsService.completeVerifiedPayment. Previously a failed payment
-- only recorded status='FAILED' with no explanation anywhere, so neither
-- support nor the customer could ever see *why* (card declined, wrong UPI
-- PIN, bank timeout, etc).

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS error_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS error_description TEXT,
  ADD COLUMN IF NOT EXISTS error_source VARCHAR(50),
  ADD COLUMN IF NOT EXISTS error_step VARCHAR(50),
  ADD COLUMN IF NOT EXISTS error_reason VARCHAR(100);

-- Lets the admin dashboard find "needs manual review" payments without a
-- full table scan (metadata->>'needs_manual_review' = 'true').
CREATE INDEX IF NOT EXISTS idx_payments_needs_manual_review
  ON payments((metadata->>'needs_manual_review'))
  WHERE metadata->>'needs_manual_review' = 'true';
