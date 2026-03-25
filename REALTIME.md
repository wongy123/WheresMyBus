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

#### `realtime_updated_at` / `realtime_updated_local`

`realtime_updated_at` is set from `rt.updatedAt` — the `Date.now()` timestamp captured at parse time (not the feed's own timestamp). `realtime_updated_local` is the human-readable GMT+10 equivalent.

---

## Post-enrichment Logic

### Ghost filter (stop timetable)

Applied in `getUpcomingByStop` and `getUpcomingByStation` after enrichment:

```javascript
const visible = enriched.filter(r =>
  r.vehicle_current_stop_sequence == null ||
  r.vehicle_current_stop_sequence <= r.stop_sequence
);
```

If `vehicle_current_stop_sequence > stop_sequence`, the vehicle has physically departed from (or passed) this stop even though its scheduled time is still within the query window. The row is removed from the response.

`getUpcomingByStation` uses the same position ghost filter only.

### Stale / behind correction (route upcoming)

Applied in `getUpcomingByRoute` after enrichment. This addresses cases where the time-window CTE returns a stop that disagrees with where the vehicle actually is according to the position feed.

`vehicle_current_stop_sequence` is compared against `stop_sequence` for each enriched row:

**Stale** (`veh_seq > stop_sequence`):
The vehicle has physically passed the stop the time window returned. A replacement query fetches the stop at `stop_sequence >= veh_seq` within the same time window:

```sql
WHERE trip_id = $tripId
  AND stop_sequence >= $currentSeq
  AND win_sec BETWEEN $startSec AND $endSec
ORDER BY stop_sequence ASC
LIMIT 1
```

**Behind** (`veh_seq < stop_sequence`):
The time window has jumped ahead of the vehicle — the delay in the trip update is stale or underestimated, so intermediate stops' estimated arrivals fell below `secNow`. Steps back to the stop the vehicle is actually heading to, but only if that stop is within 8 minutes overdue (`MAX_OVERDUE_SEC = 480`):

```sql
WHERE trip_id = $tripId
  AND stop_sequence = $currentSeq
  AND event_sec >= $minSec          -- minSec = secNow - 480
LIMIT 1
```

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
