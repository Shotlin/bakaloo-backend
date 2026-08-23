-- 107_cart_milestone_exclude_first_time.sql
--
-- Lets an admin exclude first-time customers from an "All users" cart
-- milestone — mirrors 106_cart_milestone_excluded_segment.sql's segment
-- exclusion, just keyed on first-order status instead of segment
-- membership. Reported problem: a brand-new customer could earn BOTH the
-- dedicated First-Time Offer AND a general "All users" milestone reward
-- on the same order, when the milestone was really meant as an ongoing
-- reward for existing customers.
--
-- Only meaningful when applicable_user_type = 'ALL'; a FIRST_TIME
-- milestone already targets first-timers exclusively (excluding them
-- would make it match nobody), so it's ignored there.
--
-- Fully additive: new column defaults to false (unchanged behavior — every
-- existing "All users" milestone keeps including first-time customers
-- exactly as it does today) unless an admin explicitly opts in per milestone.

ALTER TABLE cart_milestones
  ADD COLUMN IF NOT EXISTS exclude_first_time_users BOOLEAN NOT NULL DEFAULT false;
