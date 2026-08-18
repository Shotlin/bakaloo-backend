-- 105_admin_activity_log_user_agent.sql
--
-- admin_activity_log has ip_address but no user_agent, unlike audit_logs
-- (043_audit_logs.sql) which already has both. Adds the same column here
-- so the Activity Log dashboard page can show what device/browser an
-- admin action came from, not just its IP.
--
-- Fully additive: new nullable column only. Existing rows get NULL
-- (no user_agent was ever captured for them) — the dashboard falls back
-- to an "Unknown device" label for those.

ALTER TABLE admin_activity_log
  ADD COLUMN IF NOT EXISTS user_agent VARCHAR(500);
