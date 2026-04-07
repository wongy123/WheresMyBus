# Route Diagram Architecture Analysis

## Executive Summary

The route diagram currently uses a frontend-heavy architecture where the backend returns a flat list of trips and the frontend (Python) groups them by stop. This causes scheduled services without RT data to appear at stop 1 and then disappear after their scheduled time.

A backend-heavy architecture would be cleaner: the backend returns a list of stops, each containing a list of vehicles/services approaching it. This naturally handles scheduled services at their correct position.

---

## Current Architecture

### API Endpoints

| Endpoint | Purpose | Used By |
|----------|---------|---------|
| `GET /stops/{id}/timetable` | All trips at a stop | Stop timetable view |
| `GET /routes/{id}/upcoming` | Next upcoming stop per trip | Route timetable, Route diagram |
| `GET /routes/{id}/stops` | Canonical stops for route | Route diagram |
| `GET /routes/{id}/schedule` | Full schedule (all stops, all trips) | Route schedule view |

### Data Flow: Stop Timetable

```
User visits /stops/{id}
  ↓
Python: hx_timetable_stop()
  ↓
API: GET /stops/{id}/timetable
  ↓
Backend: getUpcomingByStop()
  - Queries stop_events_3day for ALL trips at this stop
  - Enriches with RT data where available
  - Returns flat list of trips
  ↓
Template: _stop_results.html
  - Renders each trip with scheduled/RT badge
```

**Key Point:** Returns ALL trips at a stop, including scheduled-only trips. Shows "scheduled" badge for trips without RT data.

### Data Flow: Route Diagram

```
User visits /routes/{id}
  ↓
Python: hx_timetable_route_diagram()
  ↓
Parallel API calls:
  - GET /routes/{id} (route info)
  - GET /routes/{id}/stops (canonical stops)
  - GET /routes/{id}/upcoming (live trips)
  - GET /routes/{id}/schedule (variant discovery)
  ↓
Backend: getUpcomingByRoute()
  - Queries stop_events_3day for trips on this route
  - Returns ONE ROW PER TRIP (next upcoming stop)
  - For scheduled trips: always returns stop 1
  ↓
Python: Groups trips by canonical_stop_sequence
  ↓
Template: _route_diagram.html
  - Iterates stops
  - Looks up vehicles at each stop
  - Renders diagram
```

**Key Problem:** `getUpcomingByRoute` returns ONE ROW PER TRIP. For scheduled trips without RT data, this is always the first stop. After scheduled time passes, the trip disappears (filtered out by `_filterActiveVehicles`).

---

## Backend Service Analysis

### `getUpcomingByStop` (Stop Timetable)

**File:** `server/src/services/gtfsQueries.service.js` (lines 1676-1802)

**Query:**
```sql
SELECT ... FROM stop_events_3day se
WHERE se.stop_id = $stopId
  AND se.win_sec BETWEEN $overdueSec AND $endSec
ORDER BY se.win_sec, se.route_short_name, se.trip_id, se.stop_sequence
```

**Returns:** ALL trips at this stop within time window (multiple rows per trip if trip has multiple stops in window)

**Filtering:** `_filterActiveVehicles` keeps:
- Future trips (`win_sec >= startSec`)
- Overdue trips with GPS evidence (vehicle hasn't passed this stop)

**Overdue Window:** 60 minutes (`MAX_OVERDUE_SEC = 3600`)

### `getUpcomingByRoute` (Route Diagram)

**File:** `server/src/services/gtfsQueries.service.js` (lines 1191-1550)

**Query:**
```sql
WITH filtered AS MATERIALIZED (
  SELECT ... FROM stop_events_3day
  WHERE ... AND win_sec BETWEEN $startSec AND $endSec
),
trip_next AS (
  SELECT trip_id, MIN(win_sec) AS next_win_sec FROM filtered GROUP BY trip_id
),
trip_min_seq AS (
  SELECT f.trip_id, f.win_sec, MIN(f.stop_sequence) AS min_seq
  FROM filtered f JOIN trip_next n ON f.trip_id = n.trip_id AND f.win_sec = n.next_win_sec
  GROUP BY f.trip_id, f.win_sec
)
SELECT f.* FROM filtered f JOIN trip_min_seq ms ON ...
```

**Returns:** ONE ROW PER TRIP (the row with minimum stop_sequence at the trip's earliest win_sec)

**For scheduled trips:**
- `win_sec` = scheduled departure time from stop 1
- Query returns stop 1 (min_seq)
- Trip appears at stop 1 in diagram

**For RT trips:**
- RT enrichment updates `win_sec` based on delay
- Query returns current/next stop based on RT position
- Trip appears at correct stop in diagram

**Filtering:** `_filterActiveVehicles` keeps:
- Future trips (`win_sec >= secNow`)
- Overdue trips with GPS evidence

**Overdue Window:** 8 minutes (`MAX_OVERDUE_SEC = 480`) - **MUCH SHORTER than stop timetable!**

---

## The Core Issue

### Why Scheduled Trips Disappear

1. **Before scheduled time:** Trip appears at stop 1 (correct)
2. **After scheduled time:** 
   - `win_sec < secNow` (trip is overdue)
   - No GPS evidence (scheduled-only trip)
   - `_filterActiveVehicles` filters it out
   - Trip disappears from diagram

### Why Stop Timetable Works

1. **Before scheduled time:** Trip appears at stop (correct)
2. **After scheduled time:**
   - `win_sec < startSec` but within 60-minute overdue window
   - Trip still appears with "scheduled" badge
   - User can see the service was scheduled

---

## Proposed Solution: Fix Existing `/routes/{id}/upcoming` Endpoint

### Critical Finding

The SQL window function approach **will not work** because `real_time_data` and `vehicle_latitude` are **post-enrichment fields** - they're added by JavaScript after the SQL query executes. The SQL view `stop_events_3day` contains stale `real_time_data` values that are cleared during enrichment (lines 1313-1317 in `gtfsQueries.service.js`).

### Recommended Approach: Phased Implementation

#### Phase 1: Minimal Fix (Immediate)

This approach matches the existing stop timetable behavior and requires minimal code changes.

**1. Increase Overdue Window**

**File:** `server/src/services/gtfsQueries.service.js`  
**Line:** 1344

```javascript
// Change from:
const MAX_OVERDUE_SEC = 480; // 8 minutes

// To:
const MAX_OVERDUE_SEC = 3600; // 60 minutes, consistent with getUpcomingByStop
```

**2. Add `is_scheduled` Flag**

**File:** `server/src/services/gtfsQueries.service.js`  
**Location:** In the `annotateRows` function (around line 1233-1240)

```javascript
// Add after existing annotations:
r.is_scheduled = !r.real_time_data && !r.vehicle_latitude;
```

**3. Update Filter Logic for Scheduled Trips**

**File:** `server/src/services/gtfsQueries.service.js`  
**Lines:** 1555-1576 (`_filterActiveVehicles` function)

```javascript
function _filterActiveVehicles(rows, secNow) {
  const epochNow = Math.floor(Date.now() / 1000);
  const MAX_OVERDUE_SEC = 3600; // 60 minutes - consistent with stop timetable
  
  return rows.filter(r => {
    // Always show future events
    if (r.win_sec >= secNow) return true;
    
    // For scheduled-only trips: use 60-minute overdue window
    const isScheduledOnly = !r.real_time_data && !r.vehicle_latitude;
    if (isScheduledOnly) {
      return r.win_sec >= (secNow - MAX_OVERDUE_SEC);
    }
    
    // For RT-enabled trips: use existing logic
    if (r.rt_min_stop_sequence != null && r.rt_min_stop_sequence > r.stop_sequence) {
      return false;
    }
    if (r.vehicle_current_stop_sequence != null) {
      const gpsIsFresh = r.vehicle_timestamp != null &&
        (epochNow - r.vehicle_timestamp) <= STALE_GPS_SEC;
      if (gpsIsFresh) return r.vehicle_current_stop_sequence <= r.stop_sequence;
    }
    const effectiveSec = effectiveRowSec(r);
    if (effectiveSec != null) {
      return effectiveSec >= secNow;
    }
    return false;
  });
}
```

**4. Frontend Visual Indicator**

**File:** `client/templates/timetable/_route_diagram.html`  
**Lines:** 83-104

Add a visual distinction for scheduled trips (e.g., dashed border, different icon, or "scheduled" badge).

**Trade-off:** Scheduled trips will still show at stop 1, but they'll remain visible for 60 minutes with a "scheduled" indicator.

---

#### Phase 2: Enhanced Positioning (Implemented)

After Phase 1 was deployed, Phase 2 was implemented to show scheduled trips at their actual scheduled position instead of always at stop 1.

**Approach:** Post-enrichment repositioning for scheduled trips.

The implementation adds a new `scheduledByTrip` map that identifies scheduled trips (no RT data) that are overdue (scheduled time has passed but within 60-minute window). For these trips, it queries the database to find the stop whose scheduled time is closest to current time.

**Code Changes:**

1. **Identify scheduled trips needing repositioning** (after line 1410):
```javascript
// Find scheduled trips (no RT data) that need repositioning.
// For scheduled trips, the initial query returns stop 1 (minimum win_sec),
// but we want to show them at the next upcoming stop.
const scheduledByTrip = new Map();
for (const r of enriched) {
  if (r.real_time_data || r.vehicle_latitude) continue; // Skip RT trips
  if (staleByTrip.has(r.trip_id) || behindByTrip.has(r.trip_id) || rtAheadByTrip.has(r.trip_id)) continue;
  
  const rowWinSec = Number(r.win_sec);
  if (rowWinSec < secNow && rowWinSec >= (secNow - MAX_OVERDUE_SEC)) {
    scheduledByTrip.set(r.trip_id, { currentSeq: rowSeq, winSec: rowWinSec });
  }
}
```

2. **Query for next upcoming stop** (in replacement logic):
```javascript
// Scheduled trips: find the next upcoming stop.
// This positions the trip at its next scheduled stop, not the closest stop
// (which would incorrectly show completed trips at the last stop).
for (const [tripId, { currentSeq, winSec }] of scheduledByTrip) {
  const next = db.prepare(stopSelectSql + `
    WHERE trip_id = $tripId
      AND win_sec >= $secNow
      AND win_sec BETWEEN $startSec AND $endSec
    ORDER BY win_sec ASC, stop_sequence ASC
    LIMIT 1
  `).get({ tripId, secNow, startSec: secNow - MAX_OVERDUE_SEC, endSec: secEnd });
  if (next) out.push(next);
}
```

3. **Include in replacement set**:
```javascript
const replacedTrips = new Set([...staleByTrip.keys(), ...behindByTrip.keys(), ...rtAheadByTrip.keys(), ...scheduledByTrip.keys()]);
```

**Why `win_sec >= secNow` instead of `ABS(win_sec - secNow)`:**

Using `win_sec >= secNow` finds the **next upcoming stop** rather than the **closest stop**. This is semantically correct for route diagrams:

- **On-time trip at stop 5**: Shows at stop 5 (next upcoming)
- **5-min late at stop 5**: Shows at stop 6 (next upcoming, since stop 5's time passed)
- **Completed trip**: No future stops → filtered out ✓

The previous approach (`ABS(win_sec - secNow)`) would incorrectly show completed trips at the last stop because that's the closest to current time.

**Result:** Scheduled trips now appear at their next upcoming stop, providing accurate positioning without showing completed trips.

---

## Edge Cases Analysis

| Edge Case | Handling | Notes |
|-----------|----------|-------|
| **Cross-midnight trips** | ✅ Handled | `stop_events_3day` uses `win_sec` adjusted by ±86400 |
| **Multi-variant routes** | ✅ Handled | `resolveRouteFamily()` and `route_short_name` matching |
| **Partial RT data** | ⚠️ Needs care | Check both `real_time_data` AND `vehicle_latitude` |
| **Trip just starting** | ✅ Handled | `tripNotStarted` check (lines 1247-1250) |
| **Stale GPS at depot** | ✅ Handled | Existing `tripNotStarted` logic |

---

## Performance Impact

**Phase 1:** Negligible - only changes constants and adds a boolean flag.

**Phase 2:** Acceptable overhead:
- Route diagram endpoint is called once per route view (not per-stop)
- For a busy route (e.g., route 130): ~100 trips × ~50 stops = 5000 rows
- SQLite handles this efficiently
- Post-enrichment repositioning only processes scheduled trips (typically < 20% of results)

---

## Files to Modify

### Phase 1 (Minimal Fix)

| File | Lines | Change |
|------|-------|--------|
| `server/src/services/gtfsQueries.service.js` | 1344 | `MAX_OVERDUE_SEC = 3600` |
| `server/src/services/gtfsQueries.service.js` | 1233-1240 | Add `is_scheduled` flag in `annotateRows` |
| `server/src/services/gtfsQueries.service.js` | 1555-1576 | Update `_filterActiveVehicles` for scheduled trips |
| `client/templates/timetable/_route_diagram.html` | 83-104 | Add visual indicator for scheduled trips |

### Phase 2 (Enhanced Positioning)

| File | Lines | Change |
|------|-------|--------|
| `server/src/services/gtfsQueries.service.js` | 1441-1525 | Add post-enrichment repositioning for scheduled trips |

---

## Why SQL Window Function Won't Work

The proposed SQL modification:

```sql
CASE WHEN f.real_time_data = 1 OR f.vehicle_latitude IS NOT NULL 
     THEN f.stop_sequence 
     ELSE ABS(f.win_sec - $secNow) 
END
```

**Problem:** `real_time_data` and `vehicle_latitude` are **not available in SQL**:
- `real_time_data` in `stop_events_3day` is stale (cleared at line 1313-1317)
- `vehicle_latitude` is added during enrichment (from Redis cache)
- The SQL query runs **before** enrichment

This is why we must use post-enrichment logic in JavaScript.

---

## Next Steps

1. **Implement Phase 1** (minimal fix)
2. Test with scheduled and RT trips
3. Validate behavior matches stop timetable
4. **Later:** Implement Phase 2 (enhanced positioning) if needed