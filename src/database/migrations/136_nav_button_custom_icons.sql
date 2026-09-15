-- 136_nav_button_custom_icons.sql
--
-- Lets an admin upload their own icon image for the 5th nav button instead
-- of only picking from the curated Phosphor set (135_nav_buttons.sql).
-- Both options coexist — icon_type picks which one this row uses.
--
--   PRESET — unchanged from before: icon_key + accent_color, rendered as
--            a colored circular badge (a vector glyph needs that
--            background to read cleanly at nav-bar size).
--   CUSTOM — a real uploaded image, rendered as-is with NO badge/circle
--            behind it, same as the app's own 4 built-in tab icons
--            (Home/Orders/Categories/Profile, which are already plain
--            PNGs) — a brand logo or promotional icon loses its own
--            colors and shape if forced into a colored circle.
--            custom_icon_active_url is the "filled" image and is
--            required for this type; custom_icon_inactive_url (an
--            "outline" counterpart) is optional.
--
-- icon_key is relaxed to nullable since a CUSTOM row has none; the CHECK
-- constraint enforces each type still has what it actually needs.

ALTER TABLE nav_buttons ALTER COLUMN icon_key DROP NOT NULL;

ALTER TABLE nav_buttons
  ADD COLUMN IF NOT EXISTS icon_type VARCHAR(10) NOT NULL DEFAULT 'PRESET'
    CONSTRAINT chk_nav_buttons_icon_type CHECK (icon_type IN ('PRESET', 'CUSTOM'));

ALTER TABLE nav_buttons
  ADD COLUMN IF NOT EXISTS custom_icon_active_url TEXT;

ALTER TABLE nav_buttons
  ADD COLUMN IF NOT EXISTS custom_icon_inactive_url TEXT;

ALTER TABLE nav_buttons
  ADD CONSTRAINT chk_nav_buttons_icon_source CHECK (
    (icon_type = 'PRESET' AND icon_key IS NOT NULL)
    OR (icon_type = 'CUSTOM' AND custom_icon_active_url IS NOT NULL)
  );
