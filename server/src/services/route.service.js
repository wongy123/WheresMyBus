import { pool } from '../models/db.js';
import { decodeFeeds, mergeRouteUpcoming, _internals as liveUtils } from './live.service.js';

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
  // seconds since local midnight on that AEST day
  const ymd = new Date(iso);
  const dateYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(ymd); // YYYY-MM-DD
  const timeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Australia/Brisbane',
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(ymd).split(':').map(Number);
  return { serviceDate: dateYmd, sec: timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2] };
}

async function fetchRouteUpcomingSchedule({ routeId, serviceIds, direction, startSec, endSec, limit }) {
  const params = [];
  let i = 1;

  params.push(serviceIds); const pService = `$${i++}`;
  params.push(routeId);    const pRoute   = `$${i++}`;
  params.push(direction);  const pDir     = `$${i++}`;
  params.push(startSec);   const pStart   = `$${i++}`;
  params.push(endSec);     const pEnd     = `$${i++}`;
  params.push(limit);      const pLimit   = `$${i++}`;

  // Convert HH:MM:SS -> seconds for comparisons and MIN()
  const dep_sec = `
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
        MIN(${dep_sec}) AS start_time   -- seconds since local midnight
      FROM gtfs.trips t
      JOIN gtfs.stop_times st ON st.trip_id = t.trip_id
      WHERE t.service_id = ANY (${pService}::text[])
        AND t.route_id   = ${pRoute}
        AND (${pDir}::int IS NULL OR t.direction_id::int = ${pDir}::int)
        AND st.departure_time ~ '^\\d{1,2}:\\d{2}:\\d{2}$'
      GROUP BY t.trip_id, t.route_id, t.direction_id, t.trip_headsign
    )
    SELECT *
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
  // Resolve serviceDate + active services
  const { serviceDate, sec: startSec } = secondsFromAestIso(datetime);
  const dateCompact = serviceDate.replaceAll('-', '');
  const dowCol = gtfsDowColumn(serviceDate);
  const serviceIds = await activeServiceIdsForDate(dateCompact, dowCol);

  // Optional end of window if duration provided
  const endSec = duration ? (startSec + (duration * 60)) : null;

  // Pull the scheduled window (trip starts for the route)
  const scheduleTrips = await fetchRouteUpcomingSchedule({
    routeId, serviceIds, direction, startSec, endSec, limit
  });

  // Fetch+decode live (per request) only if today
  const snapshot = useLive ? await decodeFeeds().catch(() => null) : null;

  const merged = mergeRouteUpcoming({
    scheduleTrips, serviceDate, snapshot, useLive
  });

  return {
    lastUpdated: merged.lastUpdated,
    mode: merged.mode,
    query: { routeId, direction, datetime, limit, duration, serviceDate },
    data: merged.data
  };
}