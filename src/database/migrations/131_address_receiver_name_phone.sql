-- 131_address_receiver_name_phone.sql
-- Per-address receiver name/phone. Previously every address silently
-- inherited the account's own name/phone at read time (there was nowhere
-- to store anything else) — a second address for a different recipient
-- (e.g. an office, a relative) had no way to record that. The account's
-- own display name is set once, the first time it's missing (see
-- users.service.js#NAME_REQUIRED / the Flutter address form), and never
-- overwritten by this — these columns are strictly per-address.

ALTER TABLE addresses
  ADD COLUMN IF NOT EXISTS receiver_name  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS receiver_phone VARCHAR(15);
