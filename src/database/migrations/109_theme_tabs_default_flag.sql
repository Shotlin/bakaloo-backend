-- 109_theme_tabs_default_flag.sql
-- Lets admins mark one tab per store as the tab customers land on when the
-- app opens, instead of the app hardcoding the "all" tab key.

ALTER TABLE theme_tabs ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_tabs_one_default_per_store
  ON theme_tabs (store_key)
  WHERE is_default = true AND status = 'active';
