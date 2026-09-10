-- 125_section_manifest_audience.sql
-- Extends the B2B/B2C audience split (migration 123, app_themes + banners)
-- to section_manifests — the Section Builder's actual per-tab home-screen
-- layout (product grids, banners, category tiles). Previously every viewer,
-- B2C or B2B, saw the identical section list for a tab; there was no way
-- for an admin to build B2B-specific home content at all.
--
-- Each (tab_id, audience) pair now has its own independent, ordered section
-- list — mirrors how app_themes splits into one active theme per
-- (tab_id, ab_variant, audience). Existing rows default to 'B2C' so
-- nothing changes for the current B2C storefront.

ALTER TABLE section_manifests
  ADD COLUMN IF NOT EXISTS audience VARCHAR(10) NOT NULL DEFAULT 'B2C'
    CHECK (audience IN ('B2C', 'B2B'));

ALTER TABLE section_manifest_versions
  ADD COLUMN IF NOT EXISTS audience VARCHAR(10) NOT NULL DEFAULT 'B2C'
    CHECK (audience IN ('B2C', 'B2B'));

-- sort_order is a per-(tab_id, audience) sequence now, not per-tab —
-- replace the tab-only index with one that leads with audience so
-- audience-scoped listing/reordering stays index-backed.
DROP INDEX IF EXISTS idx_section_manifests_tab_order;
CREATE INDEX IF NOT EXISTS idx_section_manifests_tab_audience_order
  ON section_manifests(tab_id, audience, sort_order ASC);

DROP INDEX IF EXISTS idx_section_versions_tab;
CREATE INDEX IF NOT EXISTS idx_section_versions_tab_audience
  ON section_manifest_versions(tab_id, audience, version DESC);
