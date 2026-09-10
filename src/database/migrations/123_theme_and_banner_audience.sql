-- 123_theme_and_banner_audience.sql
--
-- B2B/B2C storefront split for themes and promotional banners.
--
-- app_themes.audience — Bakaloo enforces exactly ONE globally-active theme
-- today via idx_one_active_theme (a partial unique index on is_active,
-- with no shop_id or other column to additionally scope by). That
-- singleton concept becomes "one active theme PER AUDIENCE" — the old
-- index is dropped and recreated scoped by the new column, so a B2C
-- active theme and a B2B active theme can coexist without violating
-- uniqueness. The same per-(tab_id, ab_variant) "one active theme" rule
-- the modern tab-based builder already enforces in application code
-- (themes.repository.js#activate / workers/processors.js
-- #handleScheduledActivation) is extended the same way — see those files.
--
-- banners.audience — same additive-column pattern already used in this
-- table's history (trigger_type via 073). 'ALL' (unlike app_themes, which
-- only ever needs B2C/B2B) lets a promotional banner target both
-- audiences at once, per the original ask: B2B promotional content is
-- shown to everyone, not just B2B-enabled accounts.

ALTER TABLE app_themes ADD COLUMN IF NOT EXISTS audience VARCHAR(10) NOT NULL DEFAULT 'B2C'
  CONSTRAINT chk_app_themes_audience CHECK (audience IN ('B2C', 'B2B'));

DROP INDEX IF EXISTS idx_one_active_theme;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_theme_per_audience
  ON app_themes(audience) WHERE is_active = true;

ALTER TABLE banners ADD COLUMN IF NOT EXISTS audience VARCHAR(10) NOT NULL DEFAULT 'B2C'
  CONSTRAINT chk_banners_audience CHECK (audience IN ('B2C', 'B2B', 'ALL'));
