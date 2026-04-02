-- Pre-computed dominant route type per stop (and parent station).
-- Used by the /api/stops/bounds endpoint to return typed stop icons
-- without an expensive runtime JOIN against 3M+ stop_times rows.

DROP TABLE IF EXISTS stop_route_type;

CREATE TABLE stop_route_type AS
WITH candidates(stop_id, route_id) AS (
  -- Regular stops: direct stop_times link
  SELECT st.stop_id, t.route_id
  FROM stop_times st
  JOIN trips t ON st.trip_id = t.trip_id
  UNION ALL
  -- Parent stations: resolve via child stops
  SELECT s.stop_id, t.route_id
  FROM stops s
  JOIN stops child ON child.parent_station = s.stop_id
  JOIN stop_times st ON st.stop_id = child.stop_id
  JOIN trips t ON st.trip_id = t.trip_id
)
SELECT c.stop_id,
  CASE
    WHEN SUM(CASE WHEN r.route_type IN (1,2,12) THEN 1 ELSE 0 END) > 0 THEN 2
    WHEN SUM(CASE WHEN r.route_type = 0          THEN 1 ELSE 0 END) > 0 THEN 0
    WHEN SUM(CASE WHEN r.route_type = 4          THEN 1 ELSE 0 END) > 0 THEN 4
    ELSE 3
  END AS primary_route_type
FROM candidates c
JOIN routes r ON c.route_id = r.route_id
GROUP BY c.stop_id;

CREATE INDEX IF NOT EXISTS idx_stop_route_type_stop_id ON stop_route_type(stop_id);

-- Indexes for the lat/lon bounds query
CREATE INDEX IF NOT EXISTS idx_stops_stop_lat ON stops(stop_lat);
CREATE INDEX IF NOT EXISTS idx_stops_stop_lon ON stops(stop_lon);

-- Composite index so route+direction filters use a single seek instead of
-- scanning ~67K rows via the direction_id-only index.
CREATE INDEX IF NOT EXISTS idx_trips_route_dir ON trips(route_id, direction_id);

-- Update query planner statistics after all indexes are in place.
ANALYZE;
