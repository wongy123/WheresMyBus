# WheresMyBus — Real-Time Enrichment

This document describes how GTFS-RT data is fetched, stored, and applied to scheduled query results. All code references are to `server/src/`.

---

## Overview

Real-time data flows in two stages:

1. **Ingestion** (`services/gtfsRealtime.service.js`) — a background polling loop fetches two GTFS-RT protobuf feeds on a fixed interval, parses them, and writes structured JSON to Redis with short TTLs.

2. **Enrichment** (`services/gtfsQueries.service.js`) — after every scheduled SQL query returns rows, `enrichRowsWithRealtime()` reads the relevant Redis keys in bulk and merges delay/position data onto each row before the response is sent.

---

## Stage 1: Ingestion

### Polling loop

`startGtfsRealtimeLoop()` is called once at server start. It uses a recursive `setTimeout` (not `setInterval`) so that the next poll only starts after the previous one finishes. This prevents overlapping fetches if a feed is slow.

```
tick() called immediately on start
  └── populateCacheOnce()
        ├── fetchProto(tripUpdatesUrl)     ─┐
        └── fetchProto(vehiclePositionsUrl) ─┘  Promise.allSettled (both fetched in parallel)
              ├── buildTripUpdateMap(feed)
              ├── buildVehiclePosMap(feed)
              └── write all keys to Redis
  └── setTimeout(tick, pollMs)   ← schedules next tick after completion
```

Default poll interval is **10 seconds**, controlled by `GTFS_RT_POLL_SECONDS` env var or `pollSeconds` in `config.json`. `Promise.allSettled` is used so a failure of one feed does not block the other.

### Feed fetching

```javascript
async function fetchProto(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`gtfsrt_fetch_failed ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
}
```

The response is a binary protobuf decoded by `gtfs-realtime-bindings` into a `FeedMessage` object.

### Parsing: TripUpdates feed

`buildTripUpdateMap(feed)` iterates `feed.entity`. Each entity with a `tripUpdate.trip.tripId` produces one map entry:

```
tripId → {
  updatedAt: Date.now(),   // milliseconds, set at parse time
  stopUpdates: [
    {
      stopSequence,        // integer or null
      stopId,              // string or null
      arrivalTime,         // epoch seconds (absolute) or null
      departureTime,       // epoch seconds (absolute) or null
      arrivalDelay,        // seconds (signed) or null
      departureDelay,      // seconds (signed) or null
    },
    ...
  ]
}
```

Entities without a `tripId`, or where `tripUpdate` is missing, are skipped.

### Parsing: VehiclePositions feed

`buildVehiclePosMap(feed)` iterates `feed.entity`. Each entity with a `vehicle.trip.tripId` produces:

```
tripId → {
  latitude,                 // float or null
  longitude,                // float or null
  vehicleId,                // string or null
  vehicleLabel,             // string or null (e.g. "5047")
  currentStopSequence,      // integer — the stop the vehicle is heading to
  timestamp,                // epoch seconds of the vehicle GPS fix
}
```

### Redis writes

After parsing, all keys are written in one `Promise.all` batch:

| Key pattern          | TTL                           | Content                            |
|----------------------|-------------------------------|------------------------------------|
| `rt:trip:<tripId>`   | `RT_TRIP_TTL_SEC` (default 300 s) | `{ tripId, updatedAt, stopUpdates }` |
| `rt:vpos:<tripId>`   | `RT_VPOS_TTL_SEC` (default 60 s)  | `{ tripId, latitude, longitude, vehicleId, vehicleLabel, currentStopSequence, timestamp }` |
| `rt:feed:ts`         | `RT_VPOS_TTL_SEC` (60 s)          | `{ ts: Date.now() }` — feed freshness marker |

**TTL rationale:**
- `rt:vpos:*` expires after **60 s** — a vehicle position is only meaningful for a short window; after a minute a bus could be anywhere.
- `rt:trip:*` expires after **300 s** — delay data stays useful longer. If the feed goes down temporarily, the last known delay is still a better estimate than "scheduled" for up to ~5 minutes.

### Key encoding

Both `tripKey()` and `vposKey()` apply the same encoding:
1. `encodeURIComponent(tripId)` — makes the key safe for Redis.
2. If the encoded result exceeds 240 characters (some GTFS feeds have very long trip IDs), a SHA1 hex digest is used instead, prefixed with `h` to avoid ambiguity.

---

## Stage 2: Enrichment

### `enrichRowsWithRealtime(rows)`

Called after every scheduled SQL query that returns rows. The function:

1. Collects all unique `trip_id` / `tripId` values from the result rows.
2. For each trip ID, builds both cache keys (`rt:trip:*` and `rt:vpos:*`).
3. Fetches all trip keys and all vpos keys in **two parallel `Promise.all` batches** (one batch per key type), so the total Redis round-trips for N trips is 2, not 2N.
4. Applies `applyRealtimeToRow(row, rt, vpos)` to each row.

Rows with no `trip_id` are returned unchanged.

#### Fallback vehicle-position matching for rail services

For GTFS-RT vehicle positions, the primary lookup is by `trip_id` (exact Redis key match). However, **unplanned or ADDED GTFS-RT services** use synthetic trip IDs (e.g. `UNPLANNED-93375730`) that will never match a scheduled `trip_id`, so their vpos Redis keys are unreachable via the primary path.

To handle this, `enrichRowsWithRealtime` builds a secondary `fallbackVposByKey` map from the live in-memory `latestVposMap` (maintained by `gtfsRealtime.service.js`). The key is:

```
"${routeShortNameFamily}|${directionId}|${vehicleLabel}"
```

For each scheduled row, if no direct Redis vpos match is found **and** the row is a rail service (`route_type IN (1, 2, 12)`), the function extracts the vehicle label from the scheduled `trip_id` suffix (e.g. `35884990-QR 25_26-41757-DM51` → `DM51`) and looks up the fallback map. This works because Translink encodes the physical train-set label in the scheduled trip ID and the same label appears in the RT position feed.

This fallback enriches rows that exist in the static schedule but whose running trip ID in the RT feed is unplanned — they get vehicle position data even though the `rt:vpos:<unplannedTripId>` key isn't associated with their scheduled `trip_id`.

### `applyRealtimeToRow(row, rt, vpos)`

Merges RT data onto a single scheduled row. Returns a new object (`{ ...row }` — original is not mutated).

#### Vehicle position fields

If `vpos` is present, the following fields are added to the row:

```
vehicle_latitude
vehicle_longitude
vehicle_id
vehicle_label
vehicle_current_stop_sequence   ← key field used for ghost filter and stale/behind correction
vehicle_timestamp               ← epoch seconds of the GPS fix
vehicle_time_local              ← vehicle_timestamp converted to HH:MM:SS at GMT+10
```

`vehicle_time_local` is computed by `epochToLocalHms(timestamp, tzOffsetHours=10)` — a manual UTC offset calculation (not relying on the system timezone).

#### Stop update matching

When `rt` (trip update data) is present, the function finds the best matching `stopTimeUpdate` entry for this row's stop:

1. **Exact sequence match**: finds the `stopUpdates` entry where `stopSequence === row.stop_sequence`.
2. **Exact stop_id match**: if no sequence match, finds the entry where `stopId === row.stop_id`.
3. **Preceding stop propagation**: if still no match, finds the stop update with the highest `stopSequence` value that is still **less than** `row.stop_sequence`. This handles GTFS-RT incremental feeds which only include stops from the vehicle's current position onwards — earlier stops no longer have explicit updates, so their delay is inferred from the most recently passed stop.

#### Delay / estimated time calculation

Once a matching `stopTimeUpdate` (called `su`) is found:

**Arrival:**
- If `su.arrivalDelay` is present: `estimated_arrival_time = secToHms(hmsToSec(scheduled_arrival_time) + arrivalDelay)`
- Else if `su.arrivalTime` is present (absolute epoch): `estimated_arrival_time = epochToHms(su.arrivalTime)` (local wall-clock time extracted from epoch)

**Departure:**
- If `su.departureDelay` is present: `estimated_departure_time = secToHms(hmsToSec(scheduled_departure_time) + departureDelay)`
- Else if `su.departureTime` is present (absolute epoch): `estimated_departure_time = epochToHms(su.departureTime)`

`hmsToSec` preserves GTFS overflow times (e.g. `25:30:00` = 91800 seconds). `secToHms` wraps back into the 0–86399 range for display.

#### `real_time_data` flag

Set to `1` on the row if **either** a trip update or a vehicle position was found. This flag drives the "sensors" icon in the UI and gates the client-side on-time check.

#### `rt_min_stop_sequence`

When `rt` is present and has at least one `stopUpdate` entry, `rt_min_stop_sequence` is set to the minimum `stopSequence` across all entries. Because GTFS-RT feeds are incremental (only stops from the vehicle's current position onwards), this value reliably identifies where the bus is — even when the VehiclePositions entry is absent or stale. It is used by the ghost filter and stale/behind correction as a fallback position hint.

#### `realtime_updated_at` / `realtime_updated_local`

`realtime_updated_at` is set from `rt.updatedAt` — the `Date.now()` timestamp captured at parse time (not the feed's own timestamp). `realtime_updated_local` is the human-readable GMT+10 equivalent.

---

## Post-enrichment Logic

### Ghost filter (stop timetable)

Applied via `_filterActiveVehicles` in `getUpcomingByStop` and `getUpcomingByStation` after enrichment. Two RT sources are checked in order to determine whether a bus has already departed a stop:

1. **Trip update check** (`rt_min_stop_sequence`, first line of defence): `applyRealtimeToRow` now computes `rt_min_stop_sequence` — the minimum `stopSequence` across all `stopUpdates` in the trip's GTFS-RT data. Because GTFS-RT feeds are incremental (only stops from the vehicle's current position onwards are included), the first entry's sequence is effectively where the bus is now. If `rt_min_stop_sequence > stop_sequence`, the bus has already passed this stop and the row is dropped.

2. **GPS freshness check** (`vehicle_current_stop_sequence`, second safeguard): if the GPS fix is fresh (i.e. `Date.now()/1000 - vehicle_timestamp <= STALE_GPS_SEC` where `STALE_GPS_SEC = 300`), `vehicle_current_stop_sequence` is used. If `vehicle_current_stop_sequence > stop_sequence` the row is dropped; if `<= stop_sequence` it is kept. Stale GPS fixes (older than 5 minutes) are ignored entirely to prevent ghost entries from buses whose VehiclePositions entry has frozen while the bus kept moving.

3. **Scheduled time fallback**: if neither RT source is usable, overdue rows (`win_sec < secNow`) are dropped.

```javascript
function _filterActiveVehicles(rows, secNow) {
  const epochNow = Math.floor(Date.now() / 1000);
  return rows.filter(r => {
    if (r.win_sec >= secNow) return true;
    if (r.rt_min_stop_sequence != null && r.rt_min_stop_sequence > r.stop_sequence) {
      return false;
    }
    if (r.vehicle_current_stop_sequence != null) {
      const gpsIsFresh = r.vehicle_timestamp != null &&
        (epochNow - r.vehicle_timestamp) <= STALE_GPS_SEC;
      if (gpsIsFresh) return r.vehicle_current_stop_sequence <= r.stop_sequence;
    }
    const effectiveSec = effectiveRowSec(r);
    if (effectiveSec != null) return effectiveSec >= secNow;
    return false;
  });
}
```

`getUpcomingByStation` uses the same filter logic.

### Unplanned rail injection (`injectUnplannedRailRows`)

After the ghost filter on every stop/route result set, `injectUnplannedRailRows(rows, opts)` is called to surface GTFS-RT services whose `trip_id` begins with `UNPLANNED-` (or any synthetic prefix) and therefore have no matching rows in the static GTFS schedule.

**Flow:**
1. Calls `getVehiclePositionsWithRoutes()` to get the current live vehicle list (with next-stop data already resolved).
2. Filters to unplanned rail vehicles (`trip_id` starts with `UNPLANNED-`; `route_type IN (1, 2, 12)`).
3. Applies optional context filters: `routeShortName` (route pages), `direction`, `stopIds` set-membership (stop/station pages), and time window (`secNow`..`endSec`).
4. Builds a **deduplication key set** from the existing rows. For rail scheduled rows the key extracts the vehicle label from the `trip_id` suffix (e.g. `…-DM51`) so that an unplanned vehicle whose scheduled counterpart is already present in the result set is not injected again:
   ```
   key = "${route_short_name}|${direction_id}|${keyId}"
   // keyId = vehicle_label || labelFromTripId || vehicle_id || trip_id
   ```
5. Builds a synthetic row for each new candidate carrying all the fields the timetable templates expect (`scheduled_arrival_time`, `estimated_arrival_time`, `vehicle_latitude`, `vehicle_longitude`, etc.). The time fields are set to `secToHms(secNow + minutes_away * 60)`.
6. Appends synthetic rows to the original `rows` array and returns the combined result.

**Context parameters:**

| Parameter | Used by |
|---|---|
| `routeShortName` | `getUpcomingByRoute` — restricts to one route family |
| `direction` | `getUpcomingByRoute` — restricts to one direction |
| `stopIds` | `getUpcomingByStop`, `getUpcomingByStation` — vehicle must have its `stop_id` within this set |
| `secNow`, `endSec` | All paths — time-window bounds |

### Stale / behind correction (route upcoming)

Applied in `getUpcomingByRoute` after enrichment. This addresses cases where the time-window CTE returns a stop that disagrees with where the vehicle actually is according to the RT feeds.

#### GPS freshness gate

`vehicle_current_stop_sequence` from the VehiclePositions feed is only trusted if the GPS fix is fresh (`epochNow - vehicle_timestamp <= STALE_GPS_SEC = 300 s`). A frozen GPS position (bus stopped reporting but kept moving) would pull the row into the wrong correction bucket. When the GPS is stale or absent, the minimum `stopSequence` from the trip's `stopUpdates` (`rt_min_stop_sequence`) is used as the position hint instead — the `rtAheadByTrip` path below handles this case.

#### Correction buckets

**Stale** (`veh_seq > stop_sequence`, fresh GPS):
The vehicle has physically passed the stop the time window returned. A replacement query fetches the stop at `stop_sequence >= veh_seq` within the same time window:

```sql
WHERE trip_id = $tripId
  AND stop_sequence >= $currentSeq
  AND win_sec BETWEEN $startSec AND $endSec
ORDER BY stop_sequence ASC
LIMIT 1
```

**Behind** (`veh_seq < stop_sequence`, fresh GPS):
The time window has jumped ahead of the vehicle — the delay in the trip update is stale or underestimated, so intermediate stops' estimated arrivals fell below `secNow`. Steps back to the stop the vehicle is actually heading to, but only if that stop is within 8 minutes overdue (`MAX_OVERDUE_SEC = 480`):

```sql
WHERE trip_id = $tripId
  AND stop_sequence = $currentSeq
  AND event_sec >= $minSec          -- minSec = secNow - 480
LIMIT 1
```

**RT ahead** (`rt_min_stop_sequence > stop_sequence`, no fresh GPS):
Trip updates indicate the bus is already past the displayed stop but there is no fresh GPS to classify it as stale/behind. Advances to the first upcoming stop at `stop_sequence >= rt_min_stop_sequence`:

```sql
WHERE trip_id = $tripId
  AND stop_sequence >= $currentSeq
  AND win_sec BETWEEN $startSec AND $endSec
ORDER BY stop_sequence ASC
LIMIT 1
```

This path handles buses whose VehiclePositions entry has gone stale (frozen GPS) while the TripUpdates feed remains active — they still appear on the route diagram at the correct position.

Replacement rows are RT-enriched again with a second `enrichRowsWithRealtime` call, then the corrected rows replace their original counterparts in the final result before sorting.

---

## Failure Modes

| Condition | Behaviour |
|---|---|
| Redis unreachable | `cacheGet` returns `null` (caught silently); rows are returned with no RT enrichment — scheduled times only |
| Feed fetch fails | `Promise.allSettled` absorbs the error; that feed is skipped for this poll cycle; previous Redis values remain until their TTL expires |
| Both feeds empty | Console warning logged; no Redis writes; old values remain until TTL |
| Trip ID not in Redis | Row returned as-is with no RT fields; `real_time_data` remains `0` |
| Stop update exists but no matching stop | Preceding stop propagation returns the closest earlier stop's delay; if no preceding update exists, no delay is applied |
| `vehicle_current_stop_sequence` missing | Ghost filter and stale/behind correction are both no-ops (guarded by `!= null` checks) |
| GTFS-RT trip ID not in static GTFS (unplanned/ADDED service) | `enrichRowsWithRealtime` falls back to label-based vpos matching for rail; `injectUnplannedRailRows` injects a synthetic timetable row so the service appears in stop/route pages |

---

## `GET /api/vehicles` — Live Vehicle Positions

**Service**: `getVehiclePositionsWithRoutes(vposMap, configPath)`

Called on every `/api/vehicles` request. Resolves route/headsign data and computes the next upcoming stop for each live vehicle.

### Trip resolution

For each `trip_id` in `latestVposMap`:

1. **Planned trips**: looked up directly in `trips JOIN routes` by `trip_id IN (...)`.
2. **Unplanned/ADDED trips** (trip ID not found in static GTFS): looked up by `routeId` from the RT feed against the `routes` table. For **rail unplanned trips**, an additional query finds the best-matching scheduled trip using the vehicle label suffix encoded in scheduled trip IDs:
   ```sql
   SELECT trip_id, trip_headsign FROM stop_events_3day
   WHERE route_short_name = $routeShortName
     AND direction_id = $directionId
     AND trip_id LIKE '%-DM51'           -- label suffix from RT vehicleLabel
   ORDER BY ABS(win_sec - $targetSec) ASC, stop_sequence ASC
   LIMIT 1
   ```
   The matched `schedule_trip_id` is used to resolve stop events for this vehicle; the RT `trip_id` is still returned to the client.

### Stop event bulk fetch

A single `stop_events_3day` query fetches all upcoming stop events for all resolved trips at once (including scheduled counterpart IDs for unplanned rail). Results are grouped into `stopEventMap` keyed by `trip_id`.

### Next-stop selection (`pickNextStop`)

For each vehicle, `pickNextStop(events, currentStopSequence)` selects the vehicle's next stop:

1. Computes `adjustedEventSec` for every candidate stop:
   - Extracts the best available time (estimated departure → estimated arrival → scheduled departure → scheduled arrival) and converts to seconds since midnight.
   - If the result is more than 30 minutes in the past (`sec < secNow - 1800`), adds 86 400 s — this handles midnight rollover where `secToHms` wraps 24:xx times back to 00:xx.
2. Filters to stops that are still "present or future" (`adjustedSec >= secNow - 60`). If none pass, falls back to all stops.
3. If `vehicle_current_stop_sequence` is available (non-zero), further restricts to stops where `stop_sequence >= currentStopSequence`.
4. Sorts remaining candidates by `adjustedSec` ascending (then `stop_sequence` as a tiebreaker) and returns the first.

`minutes_away` is then `max(0, round((adjustedSec - secNow) / 60))`.

### Output fields per vehicle

```
trip_id, route_id, direction_id, trip_headsign,
route_short_name, route_color, route_text_color, route_type,
lat, lon, vehicle_id, vehicle_label, timestamp,
stop_id, stop_name, stop_sequence,     ← next upcoming stop
vehicle_current_stop_sequence,          ← raw from RT position feed
minutes_away                            ← minutes to that next stop
```
