-- Migration 119: Wholesale pricing (B2B foundation)
--
-- Bakaloo has no wholesale/B2B pricing concept at all today — this adds it
-- from scratch, mirroring the exact shop-override-wins-else-master-price
-- pattern buildShopPriceJoin() already uses for retail price/sale_price
-- (products.repository.js). Nullable everywhere: a product/shop_product
-- with no wholesale_price set simply has no wholesale tier yet, admin sets
-- it per-product from the dashboard at its own pace.
--
-- Gating who can actually receive this price lives in application code
-- (resolveEffectivePriceMode, added alongside migration 120's
-- business_accounts) — these columns alone grant nothing.

ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_price DECIMAL(10,2);
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS wholesale_price DECIMAL(10,2);
