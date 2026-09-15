-- 138_nav_buttons_placement.sql
--
-- Generalizes nav_buttons (135/136) beyond just the single 5th bottom-nav
-- slot. Every column that already exists here — label, icon (preset or
-- custom), destination (including WEBVIEW + pass_identity for the
-- external-link-with-identity-handoff use case), audience, segment
-- targeting, active/schedule, sort_order — is exactly what's needed for
-- admin-configurable buttons living elsewhere in the app too (the Profile
-- screen's Business Transaction / Games buttons and friends), so this
-- reuses the whole table and admin CRUD rather than duplicating it.
--
-- placement distinguishes the two: BOTTOM_NAV keeps today's behavior
-- (exactly one row resolves per viewer — the customer-facing repository
-- query for that placement is unchanged apart from now also filtering on
-- placement, since PROFILE_MENU rows must never accidentally resolve as
-- the 5th nav slot). PROFILE_MENU is new: ALL active, audience/segment-
-- matching rows for a viewer are returned, rendered as a plain list of
-- menu buttons on the Profile screen — no "only one wins" constraint,
-- since a menu list has room for several.
ALTER TABLE nav_buttons
  ADD COLUMN IF NOT EXISTS placement VARCHAR(20) NOT NULL DEFAULT 'BOTTOM_NAV'
    CONSTRAINT chk_nav_buttons_placement CHECK (placement IN ('BOTTOM_NAV', 'PROFILE_MENU'));

CREATE INDEX IF NOT EXISTS idx_nav_buttons_placement_active
  ON nav_buttons(placement, is_active) WHERE is_active = true;
