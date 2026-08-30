-- 116_app_branding.sql
-- Singleton app-wide branding config (splash screen image + header logo),
-- editable from the dashboard so ops can swap them without an app release.
-- NULL means "use the bundled default asset" — the Flutter app already
-- ships both images, this table only overrides them.

CREATE TABLE IF NOT EXISTS app_branding (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  splash_image_url TEXT,
  logo_image_url   TEXT,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Enforce a true singleton — there is only ever one branding config.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_branding_singleton
  ON app_branding ((true));

INSERT INTO app_branding (splash_image_url, logo_image_url)
SELECT NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM app_branding);
