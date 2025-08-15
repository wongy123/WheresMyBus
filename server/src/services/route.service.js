import { pool } from '../models/db.js';
import { decodeFeeds, mergeRouteUpcoming, _internals as liveUtils } from './live.service.js';

const DEFAULT_LOOKAHEAD_SEC = 3 * 60 * 60; // 3h

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
    (split_part(st.departure_time, ':', 1)::int * 3600 +
     split_part(st.departure_time, ':', 2)::int * 60  +
     split_part(st.departure_time, ':', 3)::int)
  `;

  const sql = `
    WITH first_dep AS (
      SELECT
        t.trip_id,
        t.route_id,
        t.direction_id,
        t.trip_headsign,
        MIN(${depSec}) AS start_time
      FROM gtfs.trips t
      JOIN gtfs.stop_times st ON st.trip_id = t.trip_id
      WHERE t.service_id = ANY (${pService}::text[])
        AND t.route_id   = ${pRoute}
        AND (${pDir}::int IS NULL OR t.direction_id::int = ${pDir}::int)
        AND st.departure_time ~ '^\\d{1,2}:\\d{2}:\\d{2}$'
      GROUP BY t.trip_id, t.route_id, t.direction_id, t.trip_headsign
    )
    SELECT *, ${pSvcDate}::text AS service_date
    FROM first_dep
    WHERE start_time >= ${pStart}::int
      AND (${pEnd}::int IS NULL OR start_time <= ${pEnd}::int)
    ORDER BY start_time ASC, trip_id
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
  // 1) Work out the primary day (D) and start second
  const { serviceDate: D, sec: startSec } = secondsFromAestIso(datetime);
  const horizonSec = duration ? Math.min(24 * 60 * 60, duration * 60) : DEFAULT_LOOKAHEAD_SEC;
  const endSecD = startSec + horizonSec;

  // 2) Active services for D
  const dowD = gtfsDowColumn(D);
  const svcIdsD = await activeServiceIdsForDate(D.replaceAll('-', ''), dowD);

  // 3) Pull D slice
  const sliceD = await fetchRouteUpcomingSchedule({
    serviceDate: D, routeId, serviceIds: svcIdsD, direction,
    startSec, endSec: endSecD, limit
  });

  // 4) If we cross midnight, also pull D+1 slice [0, remainder]
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

  // 5) Merge & dedupe by (trip_id, service_date), then sort by absolute epoch and cap to limit
  const seen = new Set();
  const merged = [];
  for (const row of [...sliceD, ...sliceNext]) {
    const key = `${row.trip_id}__${row.service_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }

  // 6) Live per request if today; schedule otherwise
  const snapshot = useLive ? await decodeFeeds().catch(() => null) : null;

  // 7) Merge with live (function now uses per-row service_date)
  const result = mergeRouteUpcoming({
    scheduleTrips: merged,       // each row has { trip_id, route_id, direction_id, trip_headsign, start_time (sec), service_date }
    serviceDate: D,              // fallback only
    snapshot,
    useLive
  });

  // 8) Clip to limit after merge/sort (merge may drop canceled)
  result.data = result.data.slice(0, limit);

  return {
    lastUpdated: result.lastUpdated,
    mode: result.mode,
    query: { routeId, direction, datetime, limit, duration, serviceDate: D },
    data: result.data
  };
}