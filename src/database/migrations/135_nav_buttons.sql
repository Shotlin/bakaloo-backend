-- 135_nav_buttons.sql
--
-- The app's bottom navigation bar is hardcoded to 4 tabs (Home/Orders/
-- Categories/Profile) client-side. This adds a 5th, fully admin-configured
-- slot: label, icon, destination, and — reusing the same audience +
-- customer_segments targeting already added to banners (migration 134) —
-- who sees it. Multiple rows can be active at once; each viewer resolves
-- to at most one (see the customer-facing repository query), so a B2B
-- segment and a B2C segment can each see a different 5th button
-- simultaneously without conflicting.
--
-- destination_type/destination_value together describe where the button
-- goes:
--   APP_ROUTE  — an existing in-app screen path (e.g. '/profile/wishlist')
--   CATEGORY   — a category id (a "bundle" is a category row with
--                category_type='BUNDLE' — see 066_category_bundles_and_
--                ranking.sql — so this one type already covers bundles)
--   PRODUCT    — a product id
--   WEBVIEW    — a full URL, opened in an in-app full-screen WebView
--                (games, offer microsites, anything external or internal
--                that isn't a native screen)
--
-- pass_identity only means something for WEBVIEW: the app mints a
-- short-lived (~10 min) identity-handoff token (see auth.service.js's
-- existing TEMP_TOKEN_EXPIRY precedent for shop-selection — same shape)
-- and appends it to the URL, so the destination page can look the
-- customer up via GET /webview/session without ever seeing their real
-- login token.

CREATE TABLE nav_buttons (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label              VARCHAR(30) NOT NULL,
  -- One of a curated, app-bundled Phosphor icon set — see
  -- src/modules/admin/nav-buttons/nav-buttons.schema.js for the enum.
  -- Never a free-form asset URL: this renders at nav-bar size, so an
  -- arbitrary uploaded image would look inconsistent with the other 4
  -- tabs' icons.
  icon_key           VARCHAR(50) NOT NULL,
  -- Optional hex color for the icon's badge background (e.g. '#FF6B00'),
  -- letting this button visually stand out from the other 4 — deliberate,
  -- this slot is meant for a promo/event/game CTA, not to blend in.
  accent_color       VARCHAR(9),

  destination_type   VARCHAR(20) NOT NULL
    CONSTRAINT chk_nav_buttons_destination_type
      CHECK (destination_type IN ('APP_ROUTE', 'CATEGORY', 'PRODUCT', 'WEBVIEW')),
  destination_value  TEXT NOT NULL,
  pass_identity      BOOLEAN NOT NULL DEFAULT false,

  audience           VARCHAR(10) NOT NULL DEFAULT 'ALL'
    CONSTRAINT chk_nav_buttons_audience
      CHECK (audience IN ('B2C', 'B2B', 'ALL')),
  target_segment_id  UUID REFERENCES customer_segments(id) ON DELETE SET NULL,

  is_active          BOOLEAN NOT NULL DEFAULT true,
  start_date         TIMESTAMPTZ,
  end_date           TIMESTAMPTZ,
  sort_order         INTEGER NOT NULL DEFAULT 0,

  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nav_buttons_active
  ON nav_buttons(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_nav_buttons_target_segment_id
  ON nav_buttons(target_segment_id) WHERE target_segment_id IS NOT NULL;
