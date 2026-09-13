-- 126_theme_tabs_audience.sql
-- Extends the B2B/B2C audience split (123 — app_themes/banners, 125 —
-- section_manifests) to theme_tabs itself: the actual category-tab bar
-- ("All", "Fresh", "Dairy", "Price Drop"...) shown at the top of the home
-- screen. Until now theme_tabs had NO audience column at all — every
-- storefront, B2C or B2B, shared the exact same row per (store_key, key).
-- That meant archiving/creating a tab from the Section Builder while
-- viewing B2B silently archived/created it for B2C too (and vice versa),
-- because there was only ever one row to mutate.
--
-- Unlike app_themes/section_manifests (where content differs per audience
-- but the tab_id stays shared), the ask here is full independence of the
-- TAB LIST itself: deleting/adding a tab under one audience must never
-- touch the other's tab bar. So each audience gets its own dedicated
-- theme_tabs row (its own id), not just its own column value on a shared
-- row.
--
-- Every existing tab is implicitly B2C (the DEFAULT below), and is cloned
-- into an independent B2B counterpart so nothing visually changes right
-- after this migration — from this point on, admins manage each
-- audience's tab list independently via the (now audience-aware)
-- theme-tabs admin API.

ALTER TABLE theme_tabs
  ADD COLUMN IF NOT EXISTS audience VARCHAR(10) NOT NULL DEFAULT 'B2C'
    CHECK (audience IN ('B2C', 'B2B'));

-- Re-scope uniqueness/ordering to (store_key, audience) instead of just
-- store_key, so B2B and B2C each get their own independent key-space,
-- default-tab slot, and sort_order sequence.
DROP INDEX IF EXISTS idx_theme_tabs_active_store_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_tabs_active_store_key_key_audience
  ON theme_tabs (store_key, key, audience)
  WHERE status = 'active';

DROP INDEX IF EXISTS idx_theme_tabs_one_default_per_store;
CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_tabs_one_default_per_store_audience
  ON theme_tabs (store_key, audience)
  WHERE is_default = true AND status = 'active';

DROP INDEX IF EXISTS idx_theme_tabs_store_key_status_order;
CREATE INDEX IF NOT EXISTS idx_theme_tabs_store_key_audience_status_order
  ON theme_tabs (store_key, audience, status, sort_order ASC);

-- ─────────────────────────────────────────────────────────────────────────
-- Data migration: clone every tab into an independent B2B counterpart.
-- ─────────────────────────────────────────────────────────────────────────

-- Map of old (shared/B2C) tab id -> newly-cloned B2B tab id, keyed by the
-- (store_key, key) identity they share. Scoped to this migration's
-- transaction only.
CREATE TEMP TABLE _tab_audience_migration_map (
  old_tab_id UUID PRIMARY KEY,
  new_tab_id UUID NOT NULL
) ON COMMIT DROP;

WITH b2c_tabs AS (
  SELECT * FROM theme_tabs WHERE audience = 'B2C'
),
inserted AS (
  INSERT INTO theme_tabs (
    store_key, key, label, image_url, text_color, sort_order,
    status, is_default, merch_config, audience, created_at, updated_at,
    archived_at
  )
  SELECT
    store_key, key, label, image_url, text_color, sort_order,
    status, is_default, merch_config, 'B2B', NOW(), NOW(), archived_at
  FROM b2c_tabs
  RETURNING id, store_key, key
)
INSERT INTO _tab_audience_migration_map (old_tab_id, new_tab_id)
SELECT b2c.id, ins.id
FROM b2c_tabs b2c
JOIN inserted ins ON ins.store_key = b2c.store_key AND ins.key = b2c.key;

-- Any app_themes / section_manifests / section_manifest_versions rows an
-- admin already explicitly authored for B2B point at the old shared tab
-- id — repoint them onto the new dedicated B2B tab id so real B2B
-- customization is preserved exactly, not lost or left orphaned.
UPDATE app_themes at
SET tab_id = m.new_tab_id
FROM _tab_audience_migration_map m
WHERE at.tab_id = m.old_tab_id
  AND at.audience = 'B2B';

UPDATE section_manifests sm
SET tab_id = m.new_tab_id
FROM _tab_audience_migration_map m
WHERE sm.tab_id = m.old_tab_id
  AND sm.audience = 'B2B';

UPDATE section_manifest_versions smv
SET tab_id = m.new_tab_id
FROM _tab_audience_migration_map m
WHERE smv.tab_id = m.old_tab_id
  AND smv.audience = 'B2B';

-- Every tab that never had B2B-specific content relied entirely on the
-- "fall back to B2C when no B2B row exists" join in public.controller.js,
-- keyed off the (until now) SHARED tab_id. Once B2B gets its own tab_id
-- that trick no longer applies (there is nothing at all under the new id),
-- so seed real copies of the current B2C content onto the new B2B tab —
-- otherwise every tab an admin never explicitly customized for B2B would
-- go blank for B2B viewers the moment this migration lands.

-- Theme skin: one row per (tab, ab_variant) that's currently active and
-- has no B2B override yet.
INSERT INTO app_themes (
  name, is_active, theme_data, tab_key, tab_label, tab_icon_url, tab_order,
  status, scheduled_at, expires_at, base_theme_id, ab_variant,
  ab_split_percent, version, etag, tab_id, audience, created_at, updated_at
)
SELECT
  at.name, false, at.theme_data, at.tab_key, at.tab_label, at.tab_icon_url,
  at.tab_order, at.status, at.scheduled_at, at.expires_at, at.base_theme_id,
  at.ab_variant, at.ab_split_percent, 1, NULL, m.new_tab_id, 'B2B', NOW(),
  NOW()
FROM app_themes at
JOIN _tab_audience_migration_map m ON m.old_tab_id = at.tab_id
WHERE at.audience = 'B2C'
  AND at.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM app_themes existing_b2b
    WHERE existing_b2b.tab_id = m.new_tab_id
      AND existing_b2b.audience = 'B2B'
      AND existing_b2b.ab_variant = at.ab_variant
  );

-- Section list: whole-set clone (sections are consumed all-or-nothing —
-- see fetchSectionRows() in public.controller.js) for every tab that has
-- no B2B-specific sections yet.
INSERT INTO section_manifests (
  tab_id, section_type, sort_order, visible, config, merch_binding,
  audience, created_at, updated_at
)
SELECT
  m.new_tab_id, sm.section_type, sm.sort_order, sm.visible, sm.config,
  sm.merch_binding, 'B2B', NOW(), NOW()
FROM section_manifests sm
JOIN _tab_audience_migration_map m ON m.old_tab_id = sm.tab_id
WHERE sm.audience = 'B2C'
  AND NOT EXISTS (
    SELECT 1 FROM section_manifests existing_b2b
    WHERE existing_b2b.tab_id = m.new_tab_id
      AND existing_b2b.audience = 'B2B'
  );
