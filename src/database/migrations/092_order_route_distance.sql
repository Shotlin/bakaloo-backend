-- 092_order_route_distance.sql
--
-- Real road-route distance (store -> customer), calculated ONCE at order
-- placement via a genuine routing engine (OpenRouteService — never
-- haversine/straight-line) and stored permanently here. The admin
-- order-detail view reads these columns directly; it never calls a
-- routing API on every view.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS route_distance_meters INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS route_source VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS route_calculated_at TIMESTAMPTZ;
