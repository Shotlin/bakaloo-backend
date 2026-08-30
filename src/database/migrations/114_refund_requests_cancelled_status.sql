-- Customers can cancel their own PENDING refund request (e.g. a mistaken
-- submission) — a cancelled request frees the order up for a fresh
-- request, unlike an APPROVED or REJECTED one which is final.
ALTER TABLE refund_requests DROP CONSTRAINT refund_requests_status_check;
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'));
