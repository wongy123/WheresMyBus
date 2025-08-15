import { pool } from '../models/db.js';
import { decodeFeeds, mergeRouteUpcoming, _internals as liveUtils } from './live.service.js';

const DEFAULT_LOOKAHEAD_SEC = 24 * 60 * 60;  // 24h

/**
 * Convert YYYY-MM-DD -> YYYYMMDD (GTFS calendar dates)
 */
function ymdCompact(yyyyMmDd) {
  return String(yyyyMmDd).replaceAll('-', '');
}

/**
 * Day-of-week column for GTFS calendar (monday..sunday) from YYYY-MM-DD.
 * (We parse the date literally; for GTFS this is fine.)
 */
function gtfsDowColumn(yyyyMmDd) {
  const [y, m, d] = String(yyyyMmDd).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dow];
}

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

async function fetchRouteUpcomingSchedule({ serviceDate, routeId, serviceIds, direction, startSec, endSec, limit }) {
  const params = [];
  let i = 1;

  params.push(serviceIds); const pService = `$${i++}`;
  params.push(routeId);    const pRoute   = `$${i++}`;
  params.push(direction);  const pDir     = `$${i++}`;
  params.push(startSec);   const pStart   = `$${i++}`;
  params.push(endSec);     const pEnd     = `$${i++}`;
  params.push(limit);      const pLimit   = `$${i++}`;
  params.push(serviceDate);const pSvcDate = `$${i++}`;

  const depSec = `
    CASE WHEN st.departure_time ~ '^\\d{1,2}:\\d{2}:\\d{2}$'
         THEN split_part(st.departure_time, ':', 1)::int * 3600
            + split_part(st.departure_time, ':', 2)::int * 60
            + split_part(st.departure_time, ':', 3)::int
         ELSE NULL END
  `;
  const arrSec = `
    CASE WHEN st.arrival_time ~ '^\\d{1,2}:\\d{2}:\\d{2}$'
         THEN split_part(st.arrival_time, ':', 1)::int * 3600
            + split_part(st.arrival_time, ':', 2)::int * 60
            + split_part(st.arrival_time, ':', 3)::int
         ELSE NULL END
  `;
  const evtSec = `COALESCE(${depSec}, ${arrSec})`;

  const sql = `
    WITH st_enriched AS (
      SELECT
        t.trip_id,
        t.route_id,
        t.direction_id,
        t.trip_headsign,
        ${evtSec} AS evt_sec
      FROM gtfs.trips t
      JOIN gtfs.stop_times st ON st.trip_id = t.trip_id
      WHERE t.service_id = ANY (${pService}::text[])
        AND t.route_id   = ${pRoute}
        AND (${pDir}::int IS NULL OR t.direction_id::int = ${pDir}::int)
    ),
    next_evt AS (
      SELECT
        trip_id,
        MIN(evt_sec) FILTER (WHERE evt_sec IS NOT NULL
                             AND evt_sec >= ${pStart}::int
                             AND (${pEnd}::int IS NULL OR evt_sec <= ${pEnd}::int)
                            ) AS next_time
      FROM st_enriched
      GROUP BY trip_id
    )
    SELECT
      t.trip_id,
      t.route_id,
      t.direction_id,
      t.trip_headsign,
      ne.next_time        AS start_time,     -- seconds since local midnight AEST
      ${pSvcDate}::text   AS service_date
    FROM next_evt ne
    JOIN gtfs.trips t ON t.trip_id = ne.trip_id
    WHERE ne.next_time IS NOT NULL
    ORDER BY ne.next_time ASC, t.trip_id
    LIMIT ${pLimit};
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}


/**
 * Fetch basic route metadata (name, agency)
 */
async function fetchRouteMeta(routeId) {
  const sql = `
    SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_type
    FROM gtfs.routes r
    WHERE r.route_id = $1
    LIMIT 1;
  `;
  const { rows } = await pool.query(sql, [routeId]);
  return rows[0] ?? null;
}

/**
 * Aggregate service days (any calendar that ever serves this route).
 */
async function fetchRouteServiceDays(routeId) {
  const sql = `
    SELECT
      bool_or((c.monday   ::int)=1) AS monday,
      bool_or((c.tuesday  ::int)=1) AS tuesday,
      bool_or((c.wednesday::int)=1) AS wednesday,
      bool_or((c.thursday ::int)=1) AS thursday,
      bool_or((c.friday   ::int)=1) AS friday,
      bool_or((c.saturday ::int)=1) AS saturday,
      bool_or((c.sunday   ::int)=1) AS sunday
    FROM gtfs.trips t
    JOIN gtfs.calendar c ON c.service_id = t.service_id
    WHERE t.route_id = $1;
  `;
  const { rows } = await pool.query(sql, [routeId]);
  const r = rows[0] || {};
  const map = [
    ['Mon','monday'], ['Tue','tuesday'], ['Wed','wednesday'],
    ['Thu','thursday'], ['Fri','friday'], ['Sat','saturday'], ['Sun','sunday']
  ];
  return map.filter(([_, k]) => r[k] === true).map(([name]) => name);
}


/**
 * Get service_ids active on a given date (YYYYMMDD), using calendar + calendar_dates.
 * `dowCol` must be a constant from the safe list (no user input).
 */
async function activeServiceIdsForDate(yyyyMmDdCompact, dowCol) {
  const allowed = new Set(['monday','tuesday','wednesday','thursday','friday','saturday','sunday']);
  if (!allowed.has(dowCol)) throw new Error('Invalid day-of-week column');

  const baseSql = `
    SELECT c.service_id,
           EXISTS (SELECT 1 FROM gtfs.calendar_dates cd WHERE cd.service_id = c.service_id) AS has_cd
    FROM gtfs.calendar c
    WHERE c.start_date::int <= $1::int
      AND c.end_date::int   >= $1::int
      AND c.${dowCol}::int   = 1
      AND NOT EXISTS (
        SELECT 1 FROM gtfs.calendar_dates cd
        WHERE cd.service_id = c.service_id
          AND cd.date::int = $1::int
          AND cd.exception_type::int = 2
      );
  `;
  const addedSql = `
    SELECT cd.service_id
    FROM gtfs.calendar_dates cd
    WHERE cd.date::int = $1::int
      AND cd.exception_type::int = 1;
  `;
  const [baseRes, addRes] = await Promise.all([
    pool.query(baseSql, [yyyyMmDdCompact]),
    pool.query(addedSql, [yyyyMmDdCompact]),
  ]);

  const base = baseRes.rows;
  const added = addRes.rows.map(r => r.service_id);
  const baseNoCd = base.filter(r => r.has_cd === false).map(r => r.service_id);
  const selectedBase = baseNoCd.length ? baseNoCd : base.map(r => r.service_id);
  return Array.from(new Set([...selectedBase, ...added]));
}


/**
 * Fetch a page of trips for the route/date/direction with their first/last times.
 * We fetch limit+1 rows to compute hasNextPage without COUNT(*).
 */
async function fetchTimetablePage({ routeId, serviceIds, direction, page, limit }) {
  const offset = (page - 1) * limit;
  const limitPlus = limit + 1;

  // If no active services, short-circuit.
  if (!serviceIds.length) {
    return { trips: [], hasNextPage: false };
  }

  const params = [];
  let idx = 1;

  // $1: serviceIds[]
  params.push(serviceIds);
  const pService = `$${idx++}`;

  // $2: routeId
  params.push(routeId);
  const pRoute = `$${idx++}`;

  // $3: direction (nullable)
  params.push(direction);
  const pDir = `$${idx++}`;

  // $4, $5: limit+1, offset
  params.push(limitPlus, offset);
  const pLimit = `$${idx++}`;
  const pOffset = `$${idx++}`;

  const sql = `
    SELECT
      t.trip_id,
      t.direction_id,
      t.service_id,
      t.trip_headsign,
      -- first departure and last arrival across the trip
      (SELECT st.departure_time FROM gtfs.stop_times st WHERE st.trip_id = t.trip_id ORDER BY st.stop_sequence ASC  LIMIT 1) AS start_time,
      (SELECT st.arrival_time   FROM gtfs.stop_times st WHERE st.trip_id = t.trip_id ORDER BY st.stop_sequence DESC LIMIT 1) AS end_time
    FROM gtfs.trips t
    WHERE t.service_id = ANY (${pService}::text[])
      AND t.route_id   = ${pRoute}
      AND (${pDir}::int IS NULL OR t.direction_id::int = ${pDir}::int)
    ORDER BY start_time ASC, t.trip_id
    LIMIT ${pLimit} OFFSET ${pOffset};
  `;

  const { rows } = await pool.query(sql, params);

  const hasNextPage = rows.length > limit;
  const trips = hasNextPage ? rows.slice(0, limit) : rows;

  return { trips, hasNextPage };
}

export async function getRouteOverview({ routeId, serviceDate, direction, page, limit }) {
  const meta = await fetchRouteMeta(routeId);
  if (!meta) {
    const err = new Error(`Route ${routeId} not found`);
    err.status = 404;
    throw err;
  }

  const serviceDays = await fetchRouteServiceDays(routeId);

  const dateCompact = ymdCompact(serviceDate);
  const dowCol = gtfsDowColumn(serviceDate);
  const serviceIds = await activeServiceIdsForDate(dateCompact, dowCol);

  const { trips, hasNextPage } = await fetchTimetablePage({
    routeId, serviceIds, direction, page, limit,
  });

  return {
    route: {
      id: meta.route_id,
      shortName: meta.route_short_name,
      longName: meta.route_long_name,
      type: meta.route_type,
      serviceDays
    },
    query: { serviceDate, direction, page, limit },
    timetable: trips.map(t => ({
      tripId: t.trip_id,
      direction: t.direction_id,
      headsign: t.trip_headsign,
      startTime: t.start_time, // HH:MM:SS (may exceed 24h per GTFS)
      endTime: t.end_time
    })),
    page,
    limit,
    hasNextPage
  };
}

export async function getRouteUpcoming({ routeId, direction, datetime, limit, duration, useLive }) {
  // 1) Base day and window
  const { serviceDate: D, sec: startSec } = secondsFromAestIso(datetime);
  const horizonSec = duration ? Math.min(24 * 60 * 60, duration * 60) : DEFAULT_LOOKAHEAD_SEC;
  const endSecD = startSec + horizonSec;

  // 2) Active services for D
  const dowD = gtfsDowColumn(D);
  const svcIdsD = await activeServiceIdsForDate(D.replaceAll('-', ''), dowD);

  // --- NEW: D-1 slice for after-midnight trips on the previous service_date ---
  const Dm1 = addDaysYmd(D, -1);
  const dowDm1 = gtfsDowColumn(Dm1);
  const svcIdsDm1 = await activeServiceIdsForDate(Dm1.replaceAll('-', ''), dowDm1);

  // map real-time window [D+startSec, D+endSecD] onto D-1’s clock:
  // [86400 + startSec, 86400 + min(endSecD, 86400)]
  const prevStart = 86400 + startSec;
  const prevEnd   = 86400 + Math.min(endSecD, 86400);

  let slicePrev = [];
  if (svcIdsDm1.length && prevStart <= prevEnd) {
    slicePrev = await fetchRouteUpcomingSchedule({
      serviceDate: Dm1,
      routeId, serviceIds: svcIdsDm1, direction,
      startSec: prevStart, endSec: prevEnd, limit
    });
  }
  // --- END NEW ---

  // 3) D slice
  const sliceD = await fetchRouteUpcomingSchedule({
    serviceDate: D, routeId, serviceIds: svcIdsD, direction,
    startSec, endSec: endSecD, limit
  });

  // 4) D+1 slice if we cross midnight
  let sliceNext = [];
  if (endSecD > 86400) {
    const D1 = addDaysYmd(D, 1);
    const remainder = endSecD - 86400;
    const dowD1 = gtfsDowColumn(D1);
    const svcIdsD1 = await activeServiceIdsForDate(D1.replaceAll('-', ''), dowD1);

    sliceNext = await fetchRouteUpcomingSchedule({
      serviceDate: D1, routeId, serviceIds: svcIdsD1, direction,
      startSec: 0, endSec: remainder, limit
    });
  }

  // 5) Merge & dedupe by (trip_id, service_date)
  const seen = new Set();
  const merged = [];
  for (const row of [...slicePrev, ...sliceD, ...sliceNext]) {
    const key = `${row.trip_id}__${row.service_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }

  // 6) Live overlay (today-only)
  const snapshot = useLive ? await decodeFeeds().catch(() => null) : null;

  // 7) Merge with live (already supports per-row service_date)
  const result = mergeRouteUpcoming({
    scheduleTrips: merged,
    serviceDate: D,
    snapshot,
    useLive
  });

  // Enrich vehicle currentStopName (unchanged from your code)
  const ids = Array.from(new Set(
    result.data.map(it => it?.vehicle?.currentStopId).filter(Boolean)
  ));
  if (ids.length) {
    const { rows } = await pool.query(
      'SELECT stop_id, stop_name FROM gtfs.stops WHERE stop_id = ANY($1::text[])',
      [ids]
    );
    const nameMap = new Map(rows.map(r => [r.stop_id, r.stop_name]));
    for (const it of result.data) {
      if (it?.vehicle?.currentStopId) {
        it.vehicle.currentStopName = nameMap.get(it.vehicle.currentStopId) || null;
      }
    }
  }

  // 8) Clip to limit after merge/sort
  result.data = result.data.slice(0, limit);

  return {
    lastUpdated: result.lastUpdated,
    mode: result.mode,
    query: { routeId, direction, datetime, limit, duration, serviceDate: D },
    data: result.data
  };
}
