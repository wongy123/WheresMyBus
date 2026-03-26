# WheresMyBus — Server SQL Logic Reference

This document describes the SQL executed for every API endpoint. It is intended as a review aid to verify correctness of queries, views, and data flow.

---

## Data Sources

All GTFS static data lives in a **SQLite** database (managed by the `gtfs` npm package, config in `server/config.json`). Real-time data is written to **Redis** by the GTFS-RT polling service (`gtfsRealtime.service.js`) and merged into query results in JavaScript after the SQL returns.

The PostgreSQL database (`db.js`) is used only for user reviews/ratings — it is not involved in timetable or stop/route queries.

---

## View / Table Hierarchy

These objects are recreated by `npm run buildviews` (runs `server/sqlite/db.js`). They layer on top of the raw GTFS tables.

```
calendar + calendar_dates
    └── active_services_today / _yesterday / _tomorrow   (VIEW)
            └── trips_today / _yesterday / _tomorrow     (VIEW)
                    └── stop_times_today / _yesterday / _tomorrow  (VIEW)
                                └── stop_events_today / _yesterday / _tomorrow  (VIEW)
                                            └── stop_events_3day                (VIEW)

stop_times + trips → stop_route_type                     (TABLE, pre-computed)
```

---

### `active_services_today` (and yesterday/tomorrow)

Determines which `service_id` values are running on the target date.

```sql
-- Base calendar: correct weekday flag, date within range
SELECT service_id FROM calendar
WHERE start_date <= YYYYMMDD AND end_date >= YYYYMMDD
  AND (weekday_column = 1)
UNION
-- Added by calendar_dates exception (exception_type = 1)
SELECT service_id FROM calendar_dates WHERE date = YYYYMMDD AND exception_type = 1
EXCEPT
-- Removed by calendar_dates exception (exception_type = 2)
SELECT service_id FROM calendar_dates WHERE date = YYYYMMDD AND exception_type = 2
```

Uses SQLite `strftime('%Y%m%d', 'now', 'localtime')` and `strftime('%w', ...)` for day-of-week.
The yesterday/tomorrow variants use `'-1 day'` / `'+1 day'` modifiers.

---

### `trips_today` (and yesterday/tomorrow)

```sql
SELECT * FROM trips t
WHERE t.service_id IN (SELECT service_id FROM active_services_today)
```

Simple filter of the raw `trips` table to only active services.

---

### `stop_times_today` (and yesterday/tomorrow)

Joins `stop_times` with `trips_today` and computes integer second values for arrival and departure times. GTFS stores times as `HH:MM:SS` strings; overflow times like `25:30:00` (after midnight) are preserved as-is and handled at display time.

Key computed columns:
- `arr_sec_base` — `arrival_time` parsed to integer seconds since midnight
- `dep_sec_base` — `departure_time` parsed to integer seconds since midnight

These are used downstream to apply RT delays without string parsing.

---

### `stop_time_updates_latest`

De-duplicates the `stop_time_updates` table (which can accumulate multiple RT feed ingestions per trip/stop) by keeping only the row with the highest `rowid` per `(trip_id, stop_id)` pair.

```sql
SELECT u.trip_id, u.stop_id, u.arrival_delay, u.departure_delay
FROM stop_time_updates u
JOIN (
  SELECT trip_id, stop_id, MAX(rowid) AS max_rowid
  FROM stop_time_updates
  GROUP BY trip_id, stop_id
) m ON m.trip_id = u.trip_id AND m.stop_id = u.stop_id AND m.max_rowid = u.rowid
```

**Note:** This view is a legacy path. The primary RT enrichment path now reads delays from **Redis** in `applyRealtimeToRow()`. This view is only consulted when Redis has no entry for a trip.

---

### `stop_events_today` (and yesterday/tomorrow)

The main denormalized view used by timetable queries. Joins `stop_times_today`, `routes`, `stops`, and `stop_time_updates_latest`.

Key computed columns:
- `estimated_arrival_time` — `arr_sec_base + COALESCE(arrival_delay, 0)` formatted as `HH:MM:SS`
- `estimated_departure_time` — `dep_sec_base + COALESCE(departure_delay, 0)` formatted as `HH:MM:SS`
- `event_sec` — `COALESCE(estimated_arrival_sec, estimated_departure_sec)` — the primary sort key
- `real_time_data` — `1` if a `stop_time_updates_latest` row was joined, else `0`

Also includes `route_type` from the `routes` table (required by stop timetable to colour stop icons).

---

### `stop_events_3day`

A `UNION ALL` of all three day buckets, with `win_sec` adjusted so that a single integer range query can span midnight:

```sql
SELECT *, (event_sec - 86400) AS win_sec, 'yesterday' FROM stop_events_yesterday
UNION ALL
SELECT *, (event_sec)         AS win_sec, 'today'     FROM stop_events_today
UNION ALL
SELECT *, (event_sec + 86400) AS win_sec, 'tomorrow'  FROM stop_events_tomorrow
```

`win_sec` for yesterday rows is negative (e.g. `event_sec` of 82800 → `win_sec` = -3600).
`win_sec` for tomorrow rows exceeds 86400.
This allows a `WHERE win_sec BETWEEN startSec AND endSec` to correctly cross midnight without special-casing.

---

### `stop_route_type` (pre-computed TABLE)

Stores the dominant transit mode for every stop (and parent station). Used by `/api/stops/bounds` to return typed stop icons cheaply. Scanning 3M+ `stop_times` rows at query time would be too slow.

Priority order for `primary_route_type`:
1. Rail / metro / suburban rail (`route_type IN (1, 2, 12)`) → returns `2`
2. Tram / light rail (`route_type = 0`) → returns `0`
3. Ferry (`route_type = 4`) → returns `4`
4. Otherwise → returns `3` (bus)

Parent stations resolve via their child stops:
```sql
WITH candidates(stop_id, route_id) AS (
  -- Regular stops: direct via stop_times
  SELECT st.stop_id, t.route_id FROM stop_times st JOIN trips t ON st.trip_id = t.trip_id
  UNION ALL
  -- Parent stations: resolve through child stops
  SELECT s.stop_id, t.route_id
  FROM stops s
  JOIN stops child ON child.parent_station = s.stop_id
  JOIN stop_times st ON st.stop_id = child.stop_id
  JOIN trips t ON st.trip_id = t.trip_id
)
SELECT c.stop_id, CASE ... END AS primary_route_type
FROM candidates c JOIN routes r ON c.route_id = r.route_id
GROUP BY c.stop_id
```

Indexes created: `idx_stop_route_type_stop_id`, `idx_stops_stop_lat`, `idx_stops_stop_lon`.

---

## Real-Time Enrichment (Redis, applied after SQL)

`enrichRowsWithRealtime(rows)` runs after every SQL query that returns scheduled rows. It:

1. Collects all unique `trip_id` values from the result set.
2. Fetches two Redis keys per trip in parallel:
   - `rt:trip:<tripId>` — stop-level delay data (arrival/departure delays per stop sequence, TTL ~5 min)
   - `rt:vpos:<tripId>` — vehicle position (lat/lon, `vehicle_current_stop_sequence`, TTL ~30 s)
3. Calls `applyRealtimeToRow(row, rt, vpos)` for each row.

**Stop update matching** in `applyRealtimeToRow`:
- First tries exact match on `stop_sequence`
- Falls back to exact match on `stop_id`
- Falls back to "preceding stop propagation": uses the delay from the closest stop update with a lower sequence number (GTFS-RT incremental feeds only include stops from the vehicle's current position onwards)

**Delay application**: `estimated_arrival_time = scheduled_arrival_sec + arrivalDelay`, converted back to `HH:MM:SS`.

---

## Endpoints

---

### `GET /api/routes/search?q=`

**Service**: `getAllRoutes(searchTerm)`

```sql
SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_type, r.route_color, r.route_text_color
FROM routes r
INNER JOIN (
  SELECT route_short_name, MIN(route_id) AS min_id
  FROM routes
  GROUP BY route_short_name
) dedup ON r.route_id = dedup.min_id
```

Deduplicates by `route_short_name` — the GTFS feed may contain multiple `route_id` values for the same short name (e.g. one per timetable period). `MIN(route_id)` picks one canonical entry.

All results are fetched, then filtered and ranked **in JavaScript** using token matching against `route_short_name`, `route_long_name`, and a marketing `line_name` (e.g. "Gold Coast Line"). Rank 0 = exact short name match, rank 7 = token match only.

---

### `GET /api/routes/:routeId`

**Service**: `getOneRoute(identifier)`

```sql
SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color
FROM routes
WHERE route_id = $id OR route_short_name = $id
LIMIT 1
```

Accepts either `route_id` or `route_short_name` as the identifier.

---

### `GET /api/routes/:routeId/stops?direction=`

**Service**: `getStopsByRoute(routeId, direction)`

Finds the canonical stop list by picking the **longest trip** on that route and direction, then returning its stops in sequence order.

```sql
SELECT st.stop_sequence, st.stop_id, s.stop_name, s.stop_code, s.stop_lat, s.stop_lon
FROM stop_times st
JOIN stops s ON st.stop_id = s.stop_id
WHERE st.trip_id = (
  SELECT t.trip_id
  FROM trips t
  JOIN routes r ON t.route_id = r.route_id
  WHERE (t.route_id = $routeId OR r.route_short_name = $routeId)
    AND t.direction_id = $direction
  ORDER BY (SELECT COUNT(*) FROM stop_times WHERE trip_id = t.trip_id) DESC
  LIMIT 1
)
ORDER BY st.stop_sequence
```

The subquery selects the trip with the highest `stop_times` row count — this is the "full route" trip that serves the most stops.

---

### `GET /api/routes/:routeId/shape?direction=`

**Service**: `getRouteShape(routeId, direction)`

Same "longest trip" strategy to find a representative `shape_id`, then returns all shape points in sequence order.

```sql
SELECT sh.shape_pt_lat AS lat, sh.shape_pt_lon AS lon
FROM shapes sh
WHERE sh.shape_id = (
  SELECT t.shape_id
  FROM trips t
  JOIN routes r ON t.route_id = r.route_id
  WHERE (t.route_id = $routeId OR r.route_short_name = $routeId)
    AND t.direction_id = $direction
    AND t.shape_id IS NOT NULL
  ORDER BY (SELECT COUNT(*) FROM stop_times WHERE trip_id = t.trip_id) DESC
  LIMIT 1
)
ORDER BY sh.shape_pt_sequence
```

---

### `GET /api/routes/:routeId/schedule?direction=`

**Service**: `getRouteSchedule(routeId, direction)`

Returns a full schedule grid: every trip running today × every stop on the route, used by the timetable grid view.

```sql
SELECT st.trip_id, st.trip_headsign, st.stop_sequence, st.stop_id,
       s.stop_name, st.departure_time, st.dep_sec_base
FROM stop_times_today st
JOIN stops s ON st.stop_id = s.stop_id
WHERE st.route_id IN (
  SELECT route_id FROM routes WHERE route_id = $routeId OR route_short_name = $routeId
)
AND st.direction_id = $direction
ORDER BY st.trip_id, st.stop_sequence
```

Post-processing in JavaScript:
- Groups rows by `trip_id` to build a map of `stop_id → departure_time[:5]`
- Determines the canonical stop list from the trip with the most stops
- Sorts trips by `dep_sec_base` (first departure time of each trip) ascending

---

### `GET /api/routes/:routeId/upcoming?direction=&startTime=&duration=`

**Service**: `getUpcomingByRoute(routeId, direction, startTime, duration)`

The most complex query in the codebase. Returns one row per in-service trip: the stop the bus is currently heading to.

**Step 1 — time window query with CTEs:**

```sql
WITH filtered AS (
  -- All rows for this route/direction within the time window
  SELECT ... FROM stop_events_3day
  WHERE (route_id = $routeId OR route_short_name = $routeId)
    AND direction_id = $direction
    AND win_sec BETWEEN $startSec AND $endSec
),
trip_next AS (
  -- For each trip, find the earliest win_sec (= first stop still in the window)
  SELECT trip_id, MIN(win_sec) AS next_win_sec
  FROM filtered GROUP BY trip_id
),
trip_min_seq AS (
  -- At that earliest win_sec, find the lowest stop_sequence
  -- (handles trips that have multiple stops at the same win_sec edge)
  SELECT f.trip_id, f.win_sec, MIN(f.stop_sequence) AS min_seq
  FROM filtered f
  JOIN trip_next n ON f.trip_id = n.trip_id AND f.win_sec = n.next_win_sec
  GROUP BY f.trip_id, f.win_sec
)
SELECT f.*
FROM filtered f
JOIN trip_min_seq ms
  ON f.trip_id = ms.trip_id
 AND f.win_sec = ms.win_sec
 AND f.stop_sequence = ms.min_seq
ORDER BY f.win_sec ASC
```

This gives one row per trip — the **next upcoming stop** for that trip within the time window.

**Step 2 — RT enrichment** via Redis (`enrichRowsWithRealtime`).

**Step 3 — stale/behind correction:**

After enrichment, `vehicle_current_stop_sequence` (from GTFS-RT position feed) is compared against the `stop_sequence` returned by the CTE:

- **Stale** (`veh_seq > stop_sequence`): the vehicle has physically passed the displayed stop. Replace with the row where `stop_sequence >= veh_seq` (next stop the vehicle is heading to).
- **Behind** (`veh_seq < stop_sequence`): the time-window has jumped ahead of the vehicle — delay data is stale/underestimated. Step back to `stop_sequence = veh_seq`, but only if `event_sec >= (secNow - 480)` (capped at 8 minutes overdue, avoids showing very old stops).

These corrections require additional SQL lookups against `stop_events_3day` for the affected trips.

---

### `GET /api/stops/search?q=`

**Service**: `getAllStops(searchTerm)`

Token-split search: each whitespace-separated token must appear in `stop_name` (`AND` logic). Ranked by whether the full query is a prefix or substring.

```sql
SELECT stop_id, stop_name, stop_lat, stop_lon, location_type,
  CASE
    WHEN stop_name LIKE $fullPrefix    THEN 0
    WHEN stop_name LIKE $fullContains  THEN 1
    ELSE                                    2
  END AS sort_rank
FROM stops
WHERE stop_name LIKE $tok0 AND stop_name LIKE $tok1 ...
ORDER BY sort_rank ASC, (location_type != 1) ASC, stop_name ASC
```

The secondary sort key `(location_type != 1) ASC` floats parent stations (`location_type = 1`) to the top within each rank tier. With no search term, returns all stops ordered alphabetically (stations first).

---

### `GET /api/stops/nearby?lat=&lng=&limit=`

**Service**: `getNearbyStops(lat, lng, limit)`

**Step 1**: Fetches all stops with lat/lon (no SQL distance calculation):
```sql
SELECT stop_id, stop_name, stop_lat, stop_lon, location_type
FROM stops
WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
  AND (location_type IS NULL OR location_type IN (0, 1))
```

**Step 2**: Haversine distance computed **in JavaScript** for every stop. Sorted, top N sliced.

**Step 3**: Batch route-type lookup for the N results:
```sql
WITH candidates(stop_id, route_id) AS (
  SELECT st.stop_id, t.route_id FROM stop_times st JOIN trips t ON st.trip_id = t.trip_id
  WHERE st.stop_id IN (...)
  UNION ALL
  -- Parent stations via child stops
  SELECT s.stop_id, t.route_id FROM stops s
  JOIN stops child ON child.parent_station = s.stop_id
  JOIN stop_times st ON st.stop_id = child.stop_id
  JOIN trips t ON st.trip_id = t.trip_id
  WHERE s.stop_id IN (...)
)
SELECT c.stop_id,
  CASE
    WHEN SUM(CASE WHEN r.route_type IN (1,2,12) THEN 1 ELSE 0 END) > 0 THEN 2
    WHEN SUM(CASE WHEN r.route_type = 0          THEN 1 ELSE 0 END) > 0 THEN 0
    WHEN SUM(CASE WHEN r.route_type = 4          THEN 1 ELSE 0 END) > 0 THEN 4
    ELSE 3
  END AS primary_route_type
FROM candidates c JOIN routes r ON c.route_id = r.route_id
GROUP BY c.stop_id
```

The stop IDs are bound twice (once for regular stops, once for parent stations).

---

### `GET /api/stops/bounds?north=&south=&east=&west=&types=&limit=`

**Service**: `getStopsInBounds(north, south, east, west, types, limit)`

```sql
SELECT s.stop_id, s.stop_name, s.stop_code, s.stop_lat, s.stop_lon, s.location_type,
  COALESCE(srt.primary_route_type, 3) AS primary_route_type
FROM stops s
LEFT JOIN stop_route_type srt ON srt.stop_id = s.stop_id
WHERE s.stop_lat IS NOT NULL AND s.stop_lon IS NOT NULL
  AND (s.location_type IS NULL OR s.location_type IN (0, 1))
  AND s.stop_lat BETWEEN $south AND $north
  AND s.stop_lon BETWEEN $west AND $east
  [AND COALESCE(srt.primary_route_type, 3) IN (...)]  -- optional type filter
LIMIT $limit
```

Uses the pre-computed `stop_route_type` table (no `stop_times` scan at query time). Falls back to `3` (bus) for stops not in the table. Default `limit` is 750, max 2000.

---

### `GET /api/stops/:stopId`

**Service**: `getOneStop(stopId)`

Uses the `gtfs` npm library's `getStops({ stop_id: stopId })` helper, which is equivalent to:
```sql
SELECT * FROM stops WHERE stop_id = $stopId
```

---

### `GET /api/stops/:stopId/platforms`

**Service**: `getStopPlatforms(stationId)`

```sql
SELECT stop_id, stop_name, stop_code, stop_lat, stop_lon, platform_code
FROM stops
WHERE parent_station = $stationId
ORDER BY stop_name
```

Returns child platform stops of a station. If no rows, the caller infers the ID is a regular stop (not a station).

---

### `GET /api/stops/:stopId/routes`

**Service**: `getRoutesByStop(stopId)`

```sql
SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_type, r.route_color, r.route_text_color
FROM routes r
INNER JOIN (
  SELECT DISTINCT t.route_id
  FROM stop_times st
  JOIN trips t ON st.trip_id = t.trip_id
  WHERE st.stop_id = $stopId
) serving ON r.route_id = serving.route_id
INNER JOIN (
  SELECT route_short_name, MIN(route_id) AS min_id
  FROM routes GROUP BY route_short_name
) dedup ON r.route_id = dedup.min_id
ORDER BY r.route_short_name
```

Finds all distinct routes serving this stop (via `stop_times → trips → routes`), then deduplicates by `route_short_name` using the same `MIN(route_id)` strategy as `/routes/search`.

---

### `GET /api/stops/:stopId/timetable?startTime=&duration=`

**Service**: `getUpcomingByStation(stopId, startTime, duration)`

The timetable endpoint automatically handles both regular stops and parent stations.

**Path A — regular stop** (no child platforms found):

Delegates to `getUpcomingByStop`:
```sql
SELECT se.route_id, se.route_short_name, se.route_color, se.route_text_color, se.route_type,
       se.service_id, se.trip_id, se.trip_headsign, se.direction_id,
       se.stop_id, se.stop_code, se.stop_name, se.stop_sequence, se.win_sec,
       se.arrival_time AS scheduled_arrival_time,
       se.departure_time AS scheduled_departure_time,
       se.estimated_arrival_time, se.estimated_departure_time,
       se.arrival_delay, se.departure_delay, se.real_time_data
FROM stop_events_3day se
WHERE se.stop_id = $stopId
  AND se.win_sec BETWEEN $startSec AND $endSec
ORDER BY se.win_sec, se.route_short_name, se.trip_id, se.stop_sequence
```

After RT enrichment, a **ghost filter** removes rows where `vehicle_current_stop_sequence > stop_sequence` — the bus has physically departed from this stop even if its scheduled time is still in the window.

Results are re-sorted by effective display time: `estimated_departure || estimated_arrival || scheduled_departure || scheduled_arrival` parsed to seconds. This matches the time actually shown in the UI and avoids missorting caused by `arrival_delay` (which reflects the vehicle's current GPS stop, not the queried stop).

**Path B — parent station** (child platforms exist):

Queries `stop_events_3day` for all platform stop IDs simultaneously:
```sql
WHERE se.stop_id IN (platform_id_1, platform_id_2, ...)
  AND se.win_sec BETWEEN $startSec AND $endSec
```

Additional station-specific behaviour:
- RT data from `stop_events_*` views is **cleared** before Redis enrichment (estimated times reset to `null`, `real_time_data = 0`) — this prevents stale SQLite-baked RT data from bleeding through for trips no longer in Redis.
- Ghost filter: same as path A (position-based).
- Time ghost filter: also removes rows where `effectiveSec < startSec - 60` (arrived more than 60 s ago).
- `platform_code` added to each row from the platforms lookup.
- Re-sort: same effective-display-time sort as path A.

---

### `GET /api/geocode?q=`

No SQL. Proxies to Nominatim (OpenStreetMap geocoding API):

```
GET https://nominatim.openstreetmap.org/search?format=jsonv2&q=<q>&countrycodes=au&limit=5&addressdetails=1
```

Required because browsers cannot send a custom `User-Agent` header cross-origin, which Nominatim requires. Returns `{ data: [{ display_name, lat, lon }] }`.

---

## Potential Issues to Review

1. **`stop_time_updates_latest` is a legacy path** — RT delay data in `stop_events_*` views uses this table, but `getUpcomingByStation` clears those values and re-applies from Redis. The only case where SQLite RT matters is if the `stop_events_*` views are used directly without a subsequent `enrichRowsWithRealtime` call. Check that all query paths call `enrichRowsWithRealtime`.

2. **`getUpcomingByRoute` re-sorts by `arrival_delay`** after enrichment, but the CTE initially selects `MIN(win_sec)` from scheduled `event_sec`. If a late-running bus has a large delay, its `win_sec + arrival_delay` could place it later than another trip — the sort is correct but the initial CTE selection is still schedule-based.

3. **`active_services_*` views use `strftime('now', 'localtime')`** — this is evaluated at query time by SQLite. The views are re-evaluated on every query (they are `VIEW`, not materialized), so the date is always current. However, the server timezone must match the GTFS feed timezone (GMT+10 for Brisbane/Translink). If the server runs on UTC, `localtime` will be wrong and services will be misidentified.

4. **`getNearbyStops` loads all stops into memory** — the full `stops` table (potentially 10k+ rows) is fetched and Haversine computed in JS. This is acceptable for small GTFS feeds but could be slow for national feeds. Consider adding a rough bounding-box pre-filter in the SQL.

5. **`getStopsByRoute` / `getRouteShape` use static stop_times** (not `stop_times_today`) — they pick the longest trip ever in the feed, regardless of whether it runs today. A trip that only runs on special event days could become the "canonical" trip if it has extra stops.
