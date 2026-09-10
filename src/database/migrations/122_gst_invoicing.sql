-- 122_gst_invoicing.sql
--
-- B2B GST tax invoicing. Reuses existing infrastructure rather than
-- duplicating it:
--   - fee_settings.gst_enabled/gst_rate/gst_label (078/079) is already the
--     real, actually-charged-at-checkout tax rate — the invoice reuses it,
--     no second rate is introduced here.
--   - products.hsn_code/gst_rate + order_items.hsn_code_snapshot/
--     gst_rate_snapshot (099) already exist for the GSTR-1 report — the
--     invoice reuses these too (read off orders.items JSONB, which already
--     carries hsnCodeSnapshot/gstRateSnapshot per line — see
--     order-splitter.service.js#createOrders).
--
-- buyer_gstin/buyer_company_name are the one genuinely new piece: a tax
-- invoice must reflect the buyer's GSTIN as of the transaction, not
-- whatever their business_accounts row looks like later (a GSTIN can be
-- corrected, or the account can be suspended, after the fact) — so this is
-- a point-in-time snapshot taken at order-placement time, same reasoning
-- as every other *_snapshot column already in this schema.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_gstin VARCHAR(15);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_company_name VARCHAR(255);

ALTER TABLE bulk_orders ADD COLUMN IF NOT EXISTS buyer_gstin VARCHAR(15);
ALTER TABLE bulk_orders ADD COLUMN IF NOT EXISTS buyer_company_name VARCHAR(255);

COMMENT ON COLUMN orders.buyer_gstin IS 'Snapshot of business_accounts.gst_number at order-placement time, when the ordering customer has an APPROVED business account — independent of whether that specific order used wholesale pricing. NULL for a B2C customer with no business account.';
COMMENT ON COLUMN orders.buyer_company_name IS 'Snapshot of business_accounts.company_name at order-placement time, paired with buyer_gstin.';
