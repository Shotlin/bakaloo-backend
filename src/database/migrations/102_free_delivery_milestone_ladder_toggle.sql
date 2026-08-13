-- 102_free_delivery_milestone_ladder_toggle.sql
--
-- Reported bug: the mobile Smart Bottom Bar's merged reward ladder
-- (_buildRewardLadder in bill-summary.service.js) always mixed in the
-- global fee_settings.free_delivery_above threshold as its own checkpoint
-- alongside every real cart_milestones tier — so an admin who created
-- exactly ONE cart milestone saw what looked like TWO milestones in the
-- progress track, with no way to turn that off. The global free-delivery
-- threshold and its own "Add ₹X more to unlock FREE DELIVERY" banner
-- (deliveryFee.freeIn / freeDelivery.amountToUnlock) are untouched by this —
-- this flag controls ONLY whether it also appears as a ladder checkpoint.
-- Defaults to false (not shown as a milestone), matching what was asked for;
-- an admin who wants it back in the ladder can flip it on.

ALTER TABLE fee_settings
  ADD COLUMN IF NOT EXISTS free_delivery_in_milestone_ladder BOOLEAN NOT NULL DEFAULT false;
