import { pool } from '../models/db.js';

// ----- helpers -----
function ymdCompact(yyyyMmDd) {
  return String(yyyyMmDd).replaceAll('-', '');
}
function gtfsDowColumn(yyyyMmDd) {
  const [y, m, d] = String(yyyyMmDd).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0..6
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dow];
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
