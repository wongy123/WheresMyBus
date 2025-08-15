import { pool } from '../models/db.js';
import { decodeFeeds, _internals as liveUtils } from './live.service.js';

// ----- helpers -----
function ymdCompact(yyyyMmDd) {
  return String(yyyyMmDd).replaceAll('-', '');
}
function gtfsDowColumn(yyyyMmDd) {
  const [y, m, d] = String(yyyyMmDd).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0..6
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dow];
}

const DEFAULT_LOOKAHEAD_SEC = 24 * 60 * 60; // 24h when no duration (limit caps results)
const AEST_OFFSET = '+10:00';

function secondsFromAestIso(iso) {
  const d = iso ? new Date(iso) : new Date();
  const serviceDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(d); // YYYY-MM-DD
  const [hh, mm, ss] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Australia/Brisbane', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(d).split(':').map(Number);
  return { serviceDate, sec: hh * 3600 + mm * 60 + ss };
}
function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(dt);
}
function toAestIso(epochSec) {
  return liveUtils.toAestIso(epochSec);
}
function plannedEpochFrom(serviceDate, sec) {
  const baseMs = Date.parse(`${serviceDate}T00:00:00${AEST_OFFSET}`);
  return Math.floor(baseMs / 1000) + Number(sec || 0);
}

// ---------- stop_time lookup cache for (trip, stop) -> stop_sequence ----------
const _seqMemo = new Map();
async function getStopSequenceForTripStop(tripId, stopId) {
  const key = `${tripId}__${stopId}`;
  if (_seqMemo.has(key)) return _seqMemo.get(key);
  const { rows } = await pool.query(
    'SELECT stop_sequence FROM gtfs.stop_times WHERE trip_id = $1 AND stop_id = $2 LIMIT 1',
    [tripId, stopId]
  );
  const seq = rows[0]?.stop_sequence ? Number(rows[0].stop_sequence) : null;
  _seqMemo.set(key, seq);
  return seq;
}

// ---------- SQL: one day slice of upcoming events at stop/group ----------
async function fetchStopUpcomingSlice({
  serviceDate, groupStopIds, serviceIds, startSec, endSec, routeId, limit, rollupIsStation
}) {
  if (!groupStopIds.length || !serviceIds.length) return [];

  const params = [];
  let i = 1;
  params.push(groupStopIds); const pStops   = `$${i++}`;
  params.push(serviceIds);   const pSvcIds  = `$${i++}`;
  params.push(routeId);      const pRoute   = `$${i++}`;
  params.push(startSec);     const pStart   = `$${i++}`;
  params.push(endSec);       const pEnd     = `$${i++}`;
  params.push(limit);        const pLimit   = `$${i++}`;
  params.push(serviceDate);  const pSvcDate = `$${i++}`;
  params.push(!!rollupIsStation); const pRoll = `$${i++}`;

  const hmsToSec = (col) => `
    CASE WHEN ${col} ~ '^\\d{1,2}:\\d{2}:\\d{2}$'
         THEN split_part(${col}, ':', 1)::int * 3600
            + split_part(${col}, ':', 2)::int * 60
            + split_part(${col}, ':', 3)::int
         ELSE NULL END
  `;
  const arrSec = hmsToSec('st.arrival_time');
  const depSec = hmsToSec('st.departure_time');

  const sql = `
    WITH grp AS (SELECT unnest(${pStops}::text[]) AS stop_id),
         act AS (SELECT unnest(${pSvcIds}::text[]) AS service_id),
         stx AS (
           SELECT
             t.trip_id, t.route_id, t.direction_id, t.trip_headsign,
             st.stop_id, s.stop_name, s.platform_code,
             ${arrSec} AS arr_sec,
             ${depSec} AS dep_sec
           FROM gtfs.stop_times st
           JOIN grp g        ON g.stop_id = st.stop_id
           JOIN gtfs.trips t ON t.trip_id = st.trip_id
           JOIN act a        ON a.service_id = t.service_id
           JOIN gtfs.stops s ON s.stop_id = st.stop_id
           WHERE (${pRoute}::text IS NULL OR t.route_id = ${pRoute}::text)
         ),
         next_evt AS (
           SELECT
             trip_id, route_id, direction_id, trip_headsign,
             stop_id, stop_name, platform_code,
             CASE
               WHEN arr_sec IS NOT NULL AND arr_sec >= ${pStart}::int THEN arr_sec
               WHEN dep_sec IS NOT NULL AND (arr_sec IS NULL OR arr_sec < ${pStart}::int) AND dep_sec >= ${pStart}::int THEN dep_sec
               ELSE NULL
             END AS next_time,
             CASE
               WHEN arr_sec IS NOT NULL AND arr_sec >= ${pStart}::int THEN 'ARRIVAL'
               WHEN dep_sec IS NOT NULL AND (arr_sec IS NULL OR arr_sec < ${pStart}::int) AND dep_sec >= ${pStart}::int THEN 'DEPARTURE'
               ELSE NULL
             END AS event_type,
             arr_sec, dep_sec
           FROM stx
         ),
         filtered AS (
           SELECT *
           FROM next_evt
           WHERE next_time IS NOT NULL
             AND (${pEnd}::int IS NULL OR next_time <= ${pEnd}::int)
         ),
         ranked AS (
           SELECT *,
                  row_number() OVER (PARTITION BY trip_id ORDER BY next_time ASC, stop_id) AS rn
           FROM filtered
         )
    SELECT
      trip_id, route_id, direction_id, trip_headsign,
      stop_id, stop_name, platform_code,
      arr_sec, dep_sec, next_time, event_type,
      ${pSvcDate}::text AS service_date
    FROM ranked
    WHERE (${pRoll}::boolean = false OR rn = 1)
    ORDER BY next_time ASC, trip_id
    LIMIT ${pLimit};
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function activeServiceIdsForDate(yyyyMmDdCompact, dowCol) {
  const allowed = new Set(['monday','tuesday','wednesday','thursday','friday','saturday','sunday']);
  if (!allowed.has(dowCol)) throw new Error('Invalid day-of-week column');

  // 1) Base candidates: in date range, correct weekday, and NOT removed on that date
  const baseSql = `
    SELECT
      c.service_id,
      EXISTS (
        SELECT 1 FROM gtfs.calendar_dates cd
        WHERE cd.service_id = c.service_id
      ) AS has_cd
    FROM gtfs.calendar c
    WHERE c.start_date::int <= $1::int
      AND c.end_date::int   >= $1::int
      AND c.${dowCol}::int   = 1
      AND NOT EXISTS (
        SELECT 1 FROM gtfs.calendar_dates cd
        WHERE cd.service_id = c.service_id
          AND cd.date::int = $1::int
          AND cd.exception_type::int = 2  -- removed for this date
      );
  `;

  // 2) Explicit additions for that date
  const addedSql = `
    SELECT cd.service_id
    FROM gtfs.calendar_dates cd
    WHERE cd.date::int = $1::int
      AND cd.exception_type::int = 1;     -- added for this date
  `;

  const [baseRes, addRes] = await Promise.all([
    pool.query(baseSql, [yyyyMmDdCompact]),
    pool.query(addedSql, [yyyyMmDdCompact]),
  ]);

  const base = baseRes.rows;                       // [{ service_id, has_cd: true/false }]
  const added = addRes.rows.map(r => r.service_id);

  // 3) Tie-breaker: if any base service_ids have NO calendar_dates at all, use only those
  const baseNoCd = base.filter(r => r.has_cd === false).map(r => r.service_id);
  const selectedBase = baseNoCd.length ? baseNoCd : base.map(r => r.service_id);

  // 4) Unique union: selected base + explicit adds
  const uniq = Array.from(new Set([...selectedBase, ...added]));
  return uniq;
}

// ----- stop/station resolution -----
async function fetchStopRow(stopId) {
  const sql = `
    SELECT stop_id, stop_name, stop_lat, stop_lon,
           COALESCE(location_type::int, 0) AS location_type,
           NULLIF(parent_station,'') AS parent_station,
           platform_code
    FROM gtfs.stops
    WHERE stop_id = $1
    LIMIT 1;
  `;
  const { rows } = await pool.query(sql, [stopId]);
  return rows[0] ?? null;
}

async function fetchChildren(stationId) {
  const sql = `
    SELECT stop_id, stop_name, platform_code
    FROM gtfs.stops
    WHERE parent_station = $1
    ORDER BY stop_id;
  `;
  const { rows } = await pool.query(sql, [stationId]);
  return rows;
}

async function fetchDailyScheduleForStop(stopIds, serviceIds) {
  // Only called with a single stop/platform id, but keep API as array.
  if (!stopIds.length || !serviceIds.length) return [];

  const sql = `
    WITH grp AS (SELECT unnest($1::text[]) AS stop_id),
         active AS (SELECT DISTINCT unnest($2::text[]) AS service_id)
    SELECT DISTINCT ON (t.trip_id)
      t.trip_id,
      t.route_id,
      r.route_short_name,
      t.direction_id::int AS direction,
      t.trip_headsign,
      st.departure_time AS time
    FROM gtfs.stop_times st
    JOIN grp g          ON g.stop_id = st.stop_id
    JOIN gtfs.trips t   ON t.trip_id = st.trip_id
    JOIN active a       ON a.service_id = t.service_id
    JOIN gtfs.routes r  ON r.route_id = t.route_id
    WHERE st.departure_time IS NOT NULL
    ORDER BY t.trip_id, st.departure_time;  -- one row per trip at this stop
  `;

  const { rows } = await pool.query(sql, [stopIds, serviceIds]);

  // Group by (routeId, direction), with trips as { [tripId]: time }
  const groups = new Map(); // key -> { routeId, shortName, direction, headsigns:Set, trips:{} }

  for (const r of rows) {
    const key = `${r.route_id}__${r.direction}`;
    if (!groups.has(key)) {
      groups.set(key, {
        routeId: r.route_id,
        shortName: r.route_short_name,
        direction: r.direction,
        headsigns: new Set(),
        trips: {}
      });
    }
    const g = groups.get(key);
    if (r.trip_headsign) g.headsigns.add(r.trip_headsign);
    g.trips[r.trip_id] = r.time; // <-- trip_id : time
  }

  return Array.from(groups.values())
    .map(g => ({
      routeId: g.routeId,
      shortName: g.shortName,
      direction: g.direction,
      headsigns: Array.from(g.headsigns).sort(),
      trips: g.trips
    }))
    .sort((a, b) => {
      const snA = a.shortName || '';
      const snB = b.shortName || '';
      const byShort = snA.localeCompare(snB, undefined, { numeric: true });
      if (byShort !== 0) return byShort;
      return a.direction - b.direction;
    });
}

function classifyType(row) {
  if (row.location_type === 1) return 'station';
  if (row.parent_station) return 'platform';
  return 'stop';
}

// rollup: 'auto' | 'station' | 'stop'
async function resolveStopGroup(stopId, rollup) {
  const row = await fetchStopRow(stopId);
  if (!row) {
    const e = new Error(`Stop ${stopId} not found`);
    e.status = 404;
    throw e;
  }

  const type = classifyType(row); // "station" | "platform" | "stop"

  // 1) Explicit station rollup requested
  if (rollup === 'station') {
    // If the ID is already a station
    if (type === 'station') {
      const kids = await fetchChildren(row.stop_id);
      const groupStopIds = (kids.length ? kids.map(c => c.stop_id) : [row.stop_id]);
      return { type: 'station', base: row, stationId: row.stop_id, children: kids, groupStopIds };
    }
    // If the ID is a platform/stop with a parent, roll up to its parent station
    if (row.parent_station) {
      const stationRow = await fetchStopRow(row.parent_station);
      const kids = await fetchChildren(row.parent_station);
      const groupStopIds = (kids.length ? kids.map(c => c.stop_id) : [row.parent_station]);
      // IMPORTANT: base is the station row (so id/name/coords show the station)
      return { type: 'station', base: stationRow ?? row, stationId: row.parent_station, children: kids, groupStopIds };
    }
    // Standalone stop with no parent – nothing to roll up
    return { type: 'stop', base: row, stationId: null, children: [], groupStopIds: [row.stop_id] };
  }

  // 2) Auto mode: stations roll up to their children by default
  if (rollup === 'auto' && type === 'station') {
    const kids = await fetchChildren(row.stop_id);
    const groupStopIds = (kids.length ? kids.map(c => c.stop_id) : [row.stop_id]);
    return { type: 'station', base: row, stationId: row.stop_id, children: kids, groupStopIds };
  }

  // 3) Default: platform or standalone stop (no rollup)
  return {
    type,
    base: row,
    stationId: row.parent_station ?? null,
    children: [],
    groupStopIds: [row.stop_id]
  };
}

// ----- served routes & window for the day -----
async function fetchServedRoutesAndHeadsigns(groupStopIds, serviceIds) {
  if (!groupStopIds.length || !serviceIds.length) return [];

  const sql = `
    WITH grp AS (SELECT unnest($1::text[]) AS stop_id),
         active AS (SELECT unnest($2::text[]) AS service_id)
    SELECT
      t.route_id,
      r.route_short_name,
      t.direction_id::int AS direction,
      t.trip_headsign
    FROM gtfs.stop_times st
    JOIN grp g   ON g.stop_id = st.stop_id
    JOIN gtfs.trips t ON t.trip_id = st.trip_id
    JOIN active a ON a.service_id = t.service_id
    JOIN gtfs.routes r ON r.route_id = t.route_id
    GROUP BY t.route_id, r.route_short_name, t.direction_id, t.trip_headsign;
  `;
  const { rows } = await pool.query(sql, [groupStopIds, serviceIds]);

  // Aggregate in JS: served[routeId] -> { shortName, directions: {0:set,1:set} }
  const map = new Map();
  for (const r of rows) {
    const key = r.route_id;
    if (!map.has(key)) {
      map.set(key, { routeId: key, shortName: r.route_short_name, directions: { 0: new Set(), 1: new Set() } });
    }
    const item = map.get(key);
    const dir = (r.direction === 1 ? 1 : 0);
    if (r.trip_headsign) item.directions[dir].add(r.trip_headsign);
  }

  // to array with string arrays
  return Array.from(map.values()).map(v => ({
    routeId: v.routeId,
    shortName: v.shortName,
    directions: [
      { direction: 0, headsigns: Array.from(v.directions[0]).sort() },
      { direction: 1, headsigns: Array.from(v.directions[1]).sort() }
    ]
  })).sort((a, b) => (a.shortName || '').localeCompare(b.shortName || ''));
}

async function fetchTodayWindow(groupStopIds, serviceIds) {
  if (!groupStopIds.length || !serviceIds.length) return { firstDeparture: null, lastDeparture: null };
  const sql = `
    WITH grp AS (SELECT unnest($1::text[]) AS stop_id),
         active AS (SELECT unnest($2::text[]) AS service_id)
    SELECT MIN(st.departure_time) AS first_departure,
           MAX(st.departure_time) AS last_departure
    FROM gtfs.stop_times st
    JOIN grp g   ON g.stop_id = st.stop_id
    JOIN gtfs.trips t ON t.trip_id = st.trip_id
    JOIN active a ON a.service_id = t.service_id;
  `;
  const { rows } = await pool.query(sql, [groupStopIds, serviceIds]);
  const r = rows[0] || {};
  return {
    firstDeparture: r.first_departure || null,
    lastDeparture:  r.last_departure  || null,
  };
}

// ----- public service -----
export async function getStopOverview({ stopId, serviceDate, rollup }) {
  const resolved = await resolveStopGroup(stopId, rollup);
  const dateCompact = ymdCompact(serviceDate);
  const dowCol = gtfsDowColumn(serviceDate);
  const serviceIds = await activeServiceIdsForDate(dateCompact, dowCol);

  const served = await fetchServedRoutesAndHeadsigns(resolved.groupStopIds, serviceIds);
  const todayWindow = await fetchTodayWindow(resolved.groupStopIds, serviceIds);

  // For stop/platform, include the full-day per-route schedule at THIS stop/platform only
  let schedule;
  if (resolved.type === 'stop' || resolved.type === 'platform') {
    // IMPORTANT: schedule is for the single stop/platform, not a station rollup
    schedule = await fetchDailyScheduleForStop([resolved.base.stop_id], serviceIds);
  }

  // parent station info (only for platforms or stops with parent)
  let parentStation = null;
  if (resolved.stationId && resolved.type !== 'station') {
    const ps = await fetchStopRow(resolved.stationId);
    if (ps) parentStation = { id: ps.stop_id, name: ps.stop_name };
  }

  const children = (resolved.type === 'station')
    ? resolved.children.map(c => ({ id: c.stop_id, name: c.stop_name, platformCode: c.platform_code || null }))
    : undefined;

  return {
    type: resolved.type,  // "station" | "platform" | "stop"
    id: resolved.base.stop_id,
    name: resolved.base.stop_name,
    location: { lat: Number(resolved.base.stop_lat), lon: Number(resolved.base.stop_lon) },
    parentStation,
    ...(children ? { children } : {}),
    serviceDate,
    served,        // routes that operate here today with distinct headsigns by direction
    todayWindow,   // first/last departure today at this stop/platform
    ...(schedule ? { schedule } : {})
  };
}

// ---------- public: getStopUpcoming ----------
export async function getStopUpcoming({ stopId, datetime, routeId, rollup, limit, duration, useLive }) {
  // 1) Resolve stop group (station/platform/stop)
  const resolved = await resolveStopGroup(stopId, rollup || 'auto');
  const groupStopIds = resolved.groupStopIds;

  // 2) Window: base day (D) + maybe D-1 and D+1
  const { serviceDate: D, sec: startSec } = secondsFromAestIso(datetime);
  const horizonSec = duration ? Math.min(24 * 3600, duration * 60) : DEFAULT_LOOKAHEAD_SEC;
  const endSecD = startSec + horizonSec;

  // 3) Active services for D
  const dowD = gtfsDowColumn(D);
  const svcIdsD = await activeServiceIdsForDate(D.replaceAll('-', ''), dowD);

  // --- NEW: D-1 slice for after-midnight events that belong to previous service day ---
  const Dm1 = addDaysYmd(D, -1);
  const dowDm1 = gtfsDowColumn(Dm1);
  const svcIdsDm1 = await activeServiceIdsForDate(Dm1.replaceAll('-', ''), dowDm1);

  // For D-1, map our real-time window [D+startSec, D+endSecD] into D-1’s clock:
  // need seconds in [86400 + startSec, 86400 + min(endSecD, 86400)]
  const prevStart = 86400 + startSec;
  const prevEnd   = 86400 + Math.min(endSecD, 86400);

  let slicePrev = [];
  if (svcIdsDm1.length && prevStart <= prevEnd) {
    slicePrev = await fetchStopUpcomingSlice({
      serviceDate: Dm1,
      groupStopIds, serviceIds: svcIdsDm1,
      startSec: prevStart, endSec: prevEnd,
      routeId, limit,
      rollupIsStation: resolved.type === 'station'
    });
  }
  // --- END NEW ---

  // 4) Fetch D slice
  const sliceD = await fetchStopUpcomingSlice({
    serviceDate: D,
    groupStopIds, serviceIds: svcIdsD,
    startSec, endSec: endSecD,
    routeId, limit,
    rollupIsStation: resolved.type === 'station'
  });

  // 5) If crossing midnight, also fetch D+1 slice from 00:00 to remainder
  let sliceNext = [];
  if (endSecD > 86400) {
    const D1 = addDaysYmd(D, 1);
    const remainder = endSecD - 86400;
    const dowD1 = gtfsDowColumn(D1);
    const svcIdsD1 = await activeServiceIdsForDate(D1.replaceAll('-', ''), dowD1);

    sliceNext = await fetchStopUpcomingSlice({
      serviceDate: D1,
      groupStopIds, serviceIds: svcIdsD1,
      startSec: 0, endSec: remainder,
      routeId, limit,
      rollupIsStation: resolved.type === 'station'
    });
  }

  // 6) Merge, dedupe (trip_id + service_date)
  const seen = new Set();
  const baseRows = [];
  for (const row of [...slicePrev, ...sliceD, ...sliceNext]) {
    const key = `${row.trip_id}__${row.service_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    baseRows.push(row);
  }

  // 7) Live decode (per request) if today; schedule otherwise
  const snapshot = useLive ? await decodeFeeds().catch(() => null) : null;

  // 8) Build response rows with punctuality + vehicle enrichment (unchanged)
  const items = [];
  const vehicleStopIds = new Set();

  for (const r of baseRows) {
    const plannedArrEpoch = (r.arr_sec != null) ? plannedEpochFrom(r.service_date, r.arr_sec) : null;
    const plannedDepEpoch = (r.dep_sec != null) ? plannedEpochFrom(r.service_date, r.dep_sec) : null;
    const plannedEventEpoch = (r.event_type === 'ARRIVAL') ? plannedArrEpoch : plannedDepEpoch;

    let expectedArrEpoch = null;
    let expectedDepEpoch = null;
    let source = 'schedule';
    let delaySec = null;
    let punctualStatus = null;

    if (useLive && snapshot) {
      const tu = snapshot.tripUpdatesByTripId.get(r.trip_id);

      // Try to find a StopTimeUpdate for this stop
      let stu = null;
      if (tu && Array.isArray(tu.stopTimeUpdates)) {
        const byStopId = tu.stopTimeUpdates.find(u => (u.stopId || u.stop_id) === r.stop_id);
        if (byStopId) {
          stu = byStopId;
        } else {
          const seqForStop = await getStopSequenceForTripStop(r.trip_id, r.stop_id);
          if (seqForStop != null) {
            stu = tu.stopTimeUpdates.find(u => {
              const seq = Number(u.stopSequence ?? u.stop_sequence ?? NaN);
              return Number.isFinite(seq) && seq === seqForStop;
            }) || null;
          }
        }
      }

      // If the stop is skipped, drop this item
      const schedRel = (stu?.scheduleRelationship ?? stu?.schedule_relationship);
      if (schedRel === 1 || schedRel === 'SKIPPED') continue;

      // Expected times from STU.time or delays; else fallback to trip-level delay
      const arr = stu?.arrival || null;
      const dep = stu?.departure || null;

      if (arr?.time != null) expectedArrEpoch = Number(arr.time);
      else if (arr?.delay != null && plannedArrEpoch != null) expectedArrEpoch = plannedArrEpoch + Number(arr.delay);

      if (dep?.time != null) expectedDepEpoch = Number(dep.time);
      else if (dep?.delay != null && plannedDepEpoch != null) expectedDepEpoch = plannedDepEpoch + Number(dep.delay);

      if (tu?.tripDelay != null) {
        const d = Number(tu.tripDelay);
        if (expectedArrEpoch == null && plannedArrEpoch != null) expectedArrEpoch = plannedArrEpoch + d;
        if (expectedDepEpoch == null && plannedDepEpoch != null) expectedDepEpoch = plannedDepEpoch + d;
      }

      if (expectedArrEpoch != null || expectedDepEpoch != null) source = 'live';
    }

    const expectedEventEpoch = (r.event_type === 'ARRIVAL') ? expectedArrEpoch : expectedDepEpoch;

    if (plannedEventEpoch != null && expectedEventEpoch != null) {
      delaySec = expectedEventEpoch - plannedEventEpoch;
      punctualStatus = (delaySec > 60) ? 'DELAYED' : (delaySec < -60) ? 'EARLY' : 'ON_TIME';
    }

    // Vehicle enrichment
    let vehicle = null;
    if (snapshot) {
      const vp = snapshot.vehiclesByTripId.get(r.trip_id);
      if (vp) {
        vehicle = {
          id: vp.id,
          lat: vp.lat, lon: vp.lon,
          currentStatusCode: vp.currentStatusCode ?? null,
          currentStatus: vp.currentStatus ?? null,
          currentStatusLabel: vp.currentStatusLabel ?? null,
          currentStopId: vp.currentStopId || null,
          occupancy: vp.occupancyStatus ? { status: vp.occupancyStatus, percentage: vp.occupancyPercentage ?? null } : undefined,
          timestamp: vp.timestamp ? toAestIso(vp.timestamp) : null
        };
      }
    }

    items.push({
      tripId: r.trip_id,
      routeId: r.route_id,
      direction: Number(r.direction_id),
      headsign: r.trip_headsign,
      stop: { id: r.stop_id, name: r.stop_name, platformCode: r.platform_code || null },
      plannedArrival: plannedArrEpoch ? toAestIso(plannedArrEpoch) : null,
      plannedDeparture: plannedDepEpoch ? toAestIso(plannedDepEpoch) : null,
      expectedArrival: expectedArrEpoch ? toAestIso(expectedArrEpoch) : null,
      expectedDeparture: expectedDepEpoch ? toAestIso(expectedDepEpoch) : null,
      eventType: r.event_type,
      punctuality: (plannedEventEpoch != null) ? {
        status: punctualStatus || (source === 'live' ? 'ON_TIME' : null),
        delayMinutes: (delaySec != null) ? Math.round(delaySec / 60) : null,
        delaySeconds: delaySec
      } : null,
      vehicle,
      source
    });
  }

  // Sort by expected event time (if present) else planned
  items.sort((a, b) => {
    const aKey = a.expectedArrival || a.expectedDeparture || a.plannedArrival || a.plannedDeparture || '';
    const bKey = b.expectedArrival || b.expectedDeparture || b.plannedArrival || b.plannedDeparture || '';
    if (aKey < bKey) return -1;
    if (aKey > bKey) return 1;
    return a.tripId.localeCompare(b.tripId);
  });

  // Cap to limit
  const capped = items.slice(0, limit);

  // One-shot lookup for vehicle.currentStopName
  const ids = Array.from(new Set(capped.map(it => it?.vehicle?.currentStopId).filter(Boolean)));
  if (ids.length) {
    const { rows } = await pool.query(
      'SELECT stop_id, stop_name FROM gtfs.stops WHERE stop_id = ANY($1::text[])',
      [ids]
    );
    const nameMap = new Map(rows.map(r => [r.stop_id, r.stop_name]));
    for (const it of capped) {
      if (it?.vehicle?.currentStopId) {
        it.vehicle.currentStopName = nameMap.get(it.vehicle.currentStopId) || null;
      }
    }
  }

  const lastUpdated = snapshot?.headerTimestamp ? toAestIso(snapshot.headerTimestamp) : null;
  const mode = (useLive && snapshot) ? 'live' : 'schedule';

  return {
    lastUpdated,
    mode,
    query: { stopId, routeId, rollup: rollup || 'auto', datetime, limit, duration },
    data: capped
  };
}
