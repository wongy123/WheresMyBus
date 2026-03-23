// src/services/gtfsQueries.service.js
import { closeDb, openDb, getStops, getStopTimeUpdates } from 'gtfs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cacheGet } from './cache.service.js';
import crypto from 'node:crypto';
import { getLineNames } from '../utils/routeNames.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultConfigPath = '../../config.json';

async function loadConfig(configPath = defaultConfigPath) {
  const full = path.join(__dirname, configPath);
  return JSON.parse(await readFile(full, 'utf8'));
}

/* ----------------------------- helpers: RT merge ---------------------------- */

// time helpers
function hmsToSec(hms) {
  if (!hms || typeof hms !== 'string') return null;
  const m = hms.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]), s = Number(m[3]);
  return h * 3600 + mi * 60 + s;
}

function secToHms(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  // keep within 0..86399 for display; GTFS can roll over past midnight, clamp for UI
  const n = ((Math.floor(sec) % 86400) + 86400) % 86400;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function epochToHms(epochSeconds) {
  if (epochSeconds == null) return null;
  const d = new Date(Number(epochSeconds) * 1000);
  return secToHms(d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());
}

function epochToLocalHms(epochSeconds, tzOffsetHours = 10) {
  if (epochSeconds == null) return null;
  const d = new Date(epochSeconds * 1000); // input is seconds
  // adjust to GMT+10
  const local = new Date(d.getTime() + tzOffsetHours * 3600 * 1000);
  const h = local.getUTCHours();
  const m = local.getUTCMinutes();
  const s = local.getUTCSeconds();
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}


function epochMsToLocalHms(epochMs, tzOffsetHours = 10) {
  if (epochMs == null) return null;
  const d = new Date(Number(epochMs));
  const local = new Date(d.getTime() + tzOffsetHours * 3600 * 1000);
  const h = local.getUTCHours();
  const m = local.getUTCMinutes();
  const s = local.getUTCSeconds();
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}


function applyRealtimeToRow(row, rt, vpos) {
  if (!rt && !vpos) return row;

  const enriched = { ...row };

  // Vehicle position — short TTL key; only present if vehicle was recently seen
  if (vpos) {
    enriched.vehicle_latitude = vpos.latitude ?? null;
    enriched.vehicle_longitude = vpos.longitude ?? null;
    enriched.vehicle_id = vpos.vehicleId ?? null;
    enriched.vehicle_label = vpos.vehicleLabel ?? null;
    enriched.vehicle_current_stop_sequence = vpos.currentStopSequence ?? null;
    enriched.vehicle_timestamp = vpos.timestamp ?? null;
    enriched.vehicle_time_local = epochToLocalHms(vpos.timestamp);
  }

  if (!rt) {
    if (vpos) enriched.real_time_data = 1;
    return enriched;
  }

  // Delay / stop-update data — long TTL key; persists after position expires
  const seq = row.stop_sequence ?? row.stopSequence ?? null;
  let su = null;
  if (seq != null) {
    su = (rt.stopUpdates || []).find(u => Number(u.stopSequence) === Number(seq));
  }
  if (!su && row.stop_id) {
    su = (rt.stopUpdates || []).find(u => String(u.stopId) === String(row.stop_id));
  }
  // GTFS-RT incremental feeds only include stops from the vehicle's current position onwards.
  // If no exact match, propagate delay from the closest preceding stop update.
  if (!su && seq != null && rt.stopUpdates?.length) {
    const preceding = rt.stopUpdates
      .filter(u => u.stopSequence != null && Number(u.stopSequence) < Number(seq))
      .sort((a, b) => Number(b.stopSequence) - Number(a.stopSequence));
    if (preceding.length) su = preceding[0];
  }

  let appliedRT = false;

  if (su) {
    if (su.arrivalDelay != null) {
      enriched.arrival_delay = su.arrivalDelay;
      appliedRT = true;
    }
    if (su.departureDelay != null) {
      enriched.departure_delay = su.departureDelay;
      appliedRT = true;
    }

    // ARRIVAL
    if (su.arrivalDelay != null) {
      const schedSec = hmsToSec(enriched.scheduled_arrival_time);
      if (schedSec != null) {
        enriched.estimated_arrival_time = secToHms(schedSec + Number(su.arrivalDelay));
        appliedRT = true;
      }
    } else if (su.arrivalTime != null) {
      const hms = epochToHms(su.arrivalTime);
      if (hms) { enriched.estimated_arrival_time = hms; appliedRT = true; }
    }

    // DEPARTURE
    if (su.departureDelay != null) {
      const schedSec = hmsToSec(enriched.scheduled_departure_time);
      if (schedSec != null) {
        enriched.estimated_departure_time = secToHms(schedSec + Number(su.departureDelay));
        appliedRT = true;
      }
    } else if (su.departureTime != null) {
      const hms = epochToHms(su.departureTime);
      if (hms) { enriched.estimated_departure_time = hms; appliedRT = true; }
    }
  }

  if (appliedRT || vpos) {
    enriched.real_time_data = 1;
  }

  enriched.realtime_updated_at = rt.updatedAt ?? null;
  enriched.realtime_updated_local = epochMsToLocalHms(rt.updatedAt);
  return enriched;
}

async function enrichRowsWithRealtime(rows) {
  if (!rows?.length) return rows;

  const byTrip = new Map();
  for (const r of rows) {
    const tripId = r.trip_id || r.tripId;
    if (!tripId) continue;
    if (!byTrip.has(tripId)) byTrip.set(tripId, []);
    byTrip.get(tripId).push(r);
  }

  const tripIds = [...byTrip.keys()];
  const [rtLookups, vposLookups] = await Promise.all([
    Promise.all(tripIds.map(id => cacheGet(tripKey(id)))),
    Promise.all(tripIds.map(id => cacheGet(vposKey(id)))),
  ]);
  const rtMap   = new Map(tripIds.map((id, i) => [id, rtLookups[i]]));
  const vposMap = new Map(tripIds.map((id, i) => [id, vposLookups[i]]));

  const out = [];
  for (const r of rows) {
    const t = r.trip_id || r.tripId;
    out.push(applyRealtimeToRow(r, t ? rtMap.get(t) : null, t ? vposMap.get(t) : null));
  }
  return out;
}

function tripKey(tripId) {
  const raw = String(tripId);
  let enc = encodeURIComponent(raw);
  if (enc.length > 240) {
    const h = crypto.createHash('sha1').update(raw).digest('hex');
    enc = `h${h}`;
  }
  return `rt:trip:${enc}`;
}

function vposKey(tripId) {
  const raw = String(tripId);
  let enc = encodeURIComponent(raw);
  if (enc.length > 240) {
    const h = crypto.createHash('sha1').update(raw).digest('hex');
    enc = `h${h}`;
  }
  return `rt:vpos:${enc}`;
}

/* --------------------------------- routes ---------------------------------- */

export async function getAllRoutes(searchTerm = '', configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  // Fetch all deduplicated routes — only ~80 unique routes, fast enough to filter in JS
  const sql = `
    SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_type, r.route_color, r.route_text_color
    FROM routes r
    INNER JOIN (
      SELECT route_short_name, MIN(route_id) AS min_id
      FROM routes
      GROUP BY route_short_name
    ) dedup ON r.route_id = dedup.min_id
  `;

  const rows = db.prepare(sql).all();
  await closeDb(db);

  // Enrich with marketing line name
  const routes = rows.map(r => ({
    ...r,
    line_name: getLineNames(r.route_short_name).join(' / ') || null,
  }));

  if (!searchTerm) {
    return routes.sort((a, b) => a.route_short_name.localeCompare(b.route_short_name));
  }

  const tokens = searchTerm.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const q = searchTerm.toLowerCase();

  const scored = routes
    .map(r => {
      const sn       = (r.route_short_name || '').toLowerCase();
      const ln       = (r.route_long_name  || '').toLowerCase();
      const lineName = (r.line_name        || '').toLowerCase();

      const allTokensMatch = tokens.every(t => sn.includes(t) || ln.includes(t) || lineName.includes(t));
      if (!allTokensMatch) return null;

      let rank;
      if      (sn === q)              rank = 0;
      else if (sn.startsWith(q))     rank = 1;
      else if (ln.startsWith(q))     rank = 2;
      else if (lineName.startsWith(q)) rank = 3;
      else if (sn.includes(q))       rank = 4;
      else if (ln.includes(q))       rank = 5;
      else if (lineName.includes(q)) rank = 6;
      else                           rank = 7;

      return { ...r, sort_rank: rank };
    })
    .filter(Boolean)
    .sort((a, b) => a.sort_rank - b.sort_rank || a.route_short_name.localeCompare(b.route_short_name));

  return scored;
}

export async function getOneRoute(identifier, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const sql = `
    SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color
    FROM routes
    WHERE route_id = $id OR route_short_name = $id
    LIMIT 1
  `;

  const route = db.prepare(sql).get({ id: identifier });
  await closeDb(db);
  if (!route) return null;
  return { ...route, line_name: getLineNames(route.route_short_name).join(' / ') || null };
}

/* ---------------------------------- stops ---------------------------------- */

export async function getAllStops(searchTerm = '', configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  let sql, params;

  if (searchTerm) {
    // Split into tokens so "Adelaide St Stop 40" matches "Adelaide Street Stop 40"
    const tokens = searchTerm.trim().split(/\s+/).filter(t => t.length > 0);
    const tokenClauses = tokens.map((_, i) => `stop_name LIKE $tok${i}`).join(' AND ');
    const tokenParams = Object.fromEntries(tokens.map((t, i) => [`tok${i}`, `%${t}%`]));

    sql = `
      SELECT stop_id, stop_name, stop_lat, stop_lon, location_type,
        CASE
          WHEN stop_name LIKE $fullPrefix    THEN 0
          WHEN stop_name LIKE $fullContains  THEN 1
          ELSE                                    2
        END AS sort_rank
      FROM stops
      WHERE ${tokenClauses}
      ORDER BY sort_rank ASC, stop_name ASC
    `;
    params = {
      ...tokenParams,
      fullPrefix:   `${searchTerm}%`,
      fullContains: `%${searchTerm}%`,
    };
  } else {
    sql = `
      SELECT stop_id, stop_name, stop_lat, stop_lon, location_type
      FROM stops
      ORDER BY stop_name ASC
    `;
    params = {};
  }

  const stops = db.prepare(sql).all(params);
  await closeDb(db);
  return stops;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function getNearbyStops(lat, lng, limit = 5, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const rows = db.prepare(`
    SELECT stop_id, stop_name, stop_lat, stop_lon, location_type
    FROM stops
    WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
      AND (location_type IS NULL OR location_type IN (0, 1))
  `).all();

  const topN = rows
    .map(s => ({ ...s, distance_km: haversineKm(lat, lng, s.stop_lat, s.stop_lon) }))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);

  // Batch-resolve the dominant route_type for each nearby stop.
  // Regular stops: direct stop_times lookup.
  // Stations (location_type=1): no direct stop_times, so resolve via child stops.
  // Priority: rail/metro/tram (2) > ferry (4) > bus (3).
  if (topN.length > 0) {
    const ids = topN.map(s => s.stop_id);
    const placeholders = ids.map(() => '?').join(',');
    const rtRows = db.prepare(`
      WITH candidates(stop_id, route_id) AS (
        SELECT st.stop_id, t.route_id
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        WHERE st.stop_id IN (${placeholders})
        UNION ALL
        SELECT s.stop_id, t.route_id
        FROM stops s
        JOIN stops child ON child.parent_station = s.stop_id
        JOIN stop_times st ON st.stop_id = child.stop_id
        JOIN trips t ON st.trip_id = t.trip_id
        WHERE s.stop_id IN (${placeholders})
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
      GROUP BY c.stop_id
    `).all(...ids, ...ids);
    const rtMap = new Map(rtRows.map(r => [r.stop_id, r.primary_route_type]));
    topN.forEach(s => { s.primary_route_type = rtMap.get(s.stop_id) ?? null; });
  }

  await closeDb(db);
  return topN;
}

export async function getStopPlatforms(stationId, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const platforms = db.prepare(`
    SELECT stop_id, stop_name, stop_code, stop_lat, stop_lon, platform_code
    FROM stops
    WHERE parent_station = $stationId
    ORDER BY stop_name
  `).all({ stationId });

  await closeDb(db);
  return platforms;
}

export async function getStopsByRoute(routeId, direction = 0, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const sql = `
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
  `;

  const stops = db.prepare(sql).all({ routeId, direction });
  await closeDb(db);
  return stops;
}

export async function getRouteShape(routeId, direction = 0, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const sql = `
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
  `;

  const points = db.prepare(sql).all({ routeId, direction });
  await closeDb(db);
  return points;
}

export async function getRouteSchedule(routeId, direction = 0, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const sql = `
    SELECT
      st.trip_id,
      st.trip_headsign,
      st.stop_sequence,
      st.stop_id,
      s.stop_name,
      st.departure_time,
      st.dep_sec_base
    FROM stop_times_today st
    JOIN stops s ON st.stop_id = s.stop_id
    WHERE st.route_id IN (
      SELECT route_id FROM routes
      WHERE route_id = $routeId OR route_short_name = $routeId
    )
    AND st.direction_id = $direction
    ORDER BY st.trip_id, st.stop_sequence
  `;

  const rows = db.prepare(sql).all({ routeId, direction });
  await closeDb(db);

  if (!rows.length) return { stops: [], trips: [] };

  // Group rows by trip_id
  const tripMap = new Map();
  for (const row of rows) {
    if (!tripMap.has(row.trip_id)) {
      tripMap.set(row.trip_id, {
        trip_id: row.trip_id,
        headsign: row.trip_headsign,
        firstDep: row.dep_sec_base,
        times: {},
      });
    }
    tripMap.get(row.trip_id).times[row.stop_id] = row.departure_time.slice(0, 5);
  }

  // Canonical stop list: from the trip that covers the most stops, in sequence order
  const stopsByTrip = new Map();
  for (const row of rows) {
    if (!stopsByTrip.has(row.trip_id)) stopsByTrip.set(row.trip_id, []);
    stopsByTrip.get(row.trip_id).push({
      stop_sequence: row.stop_sequence,
      stop_id: row.stop_id,
      stop_name: row.stop_name,
    });
  }
  let canonicalStops = [];
  for (const stops of stopsByTrip.values()) {
    if (stops.length > canonicalStops.length) canonicalStops = stops;
  }

  const trips = [...tripMap.values()].sort((a, b) => a.firstDep - b.firstDep);

  return { stops: canonicalStops, trips };
}

export async function getRoutesByStop(stopId, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  // One row per route_short_name; only routes that actually serve this stop
  const sql = `
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
      FROM routes
      GROUP BY route_short_name
    ) dedup ON r.route_id = dedup.min_id
    ORDER BY r.route_short_name
  `;

  const rows = db.prepare(sql).all({ stopId });
  await closeDb(db);
  return rows;
}

export async function getOneStop(stopId, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const stop = getStops({ stop_id: stopId });

  await closeDb(db);
  return stop[0];
}

export async function getAllStopTimeUpdates(configPath = defaultConfigPath) {
  // NOTE: With stateless RT (cache-backed), this will usually be empty/unused.
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const stopTimeUpdates = getStopTimeUpdates();

  await closeDb(db);
  return stopTimeUpdates;
}

/* ------------------------ upcoming (with RT enrichment) --------------------- */

export async function getUpcomingByRoute(
  routeId,
  direction = 0,
  startTime = Math.floor(Date.now() / 1000), // epoch seconds
  duration = 7200,                           // 2 hours
  configPath = defaultConfigPath
) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  // Convert startTime (epoch seconds) to seconds since local midnight
  const date = new Date(startTime * 1000);
  const midnight = new Date(date);
  midnight.setHours(0, 0, 0, 0);
  const secNow = Math.floor((date - midnight) / 1000);
  const secEnd = secNow + duration;

  const sql = `
WITH filtered AS (
  SELECT
    route_id, route_short_name, route_color, route_text_color,
    service_id, trip_id, trip_headsign, direction_id,
    stop_id, stop_code, stop_name, stop_sequence,
    arrival_time   AS scheduled_arrival_time,
    departure_time AS scheduled_departure_time,
    estimated_arrival_time, estimated_departure_time,
    arrival_delay, departure_delay, real_time_data,
    event_sec, win_sec
  FROM stop_events_3day
  WHERE (route_id = $routeId OR route_short_name = $routeId)
    AND direction_id = $direction
    AND win_sec BETWEEN $startSec AND $endSec
),
trip_next AS (
  SELECT trip_id, MIN(win_sec) AS next_win_sec
  FROM filtered
  GROUP BY trip_id
),
trip_min_seq AS (
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
ORDER BY f.win_sec ASC;
  `;

  const params = {
    routeId,
    direction,
    startSec: secNow,
    endSec: secEnd,
  };

  const rows = db.prepare(sql).all(params);
  await closeDb(db);

  // Enrich with realtime (cache) then re-sort by effective time
  const enriched = await enrichRowsWithRealtime(rows);
  enriched.sort((a, b) =>
    (a.win_sec + (a.arrival_delay || 0)) - (b.win_sec + (b.arrival_delay || 0))
  );
  return enriched;
}

export async function getUpcomingByStop(
  stopId,
  startTime = Math.floor(Date.now() / 1000), // epoch seconds (defaults to now)
  duration = 7200,                           // 2 hours
  configPath = defaultConfigPath
) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  // Convert startTime (epoch seconds) -> seconds since local midnight
  const date = new Date(startTime * 1000);
  const midnight = new Date(date);
  midnight.setHours(0, 0, 0, 0);
  const startSec = Math.floor((date - midnight) / 1000);
  const endSec = startSec + duration;

  const sql = `
    SELECT
      se.route_id,
      se.route_short_name,
      se.route_color,
      se.route_text_color,
      se.service_id,
      se.trip_id,
      se.trip_headsign,
      se.direction_id,
      se.stop_id,
      se.stop_code,
      se.stop_name,
      se.stop_sequence,
      se.win_sec,
      se.arrival_time   AS scheduled_arrival_time,
      se.departure_time AS scheduled_departure_time,
      se.estimated_arrival_time,
      se.estimated_departure_time,
      se.arrival_delay,
      se.departure_delay,
      se.real_time_data
    FROM stop_events_3day se
    WHERE se.stop_id = $stopId
      AND se.win_sec BETWEEN $startSec AND $endSec
    ORDER BY se.win_sec, se.route_short_name, se.trip_id, se.stop_sequence
  `;

  const params = {
    stopId: String(stopId),
    startSec,
    endSec
  };

  const rows = db.prepare(sql).all(params);
  await closeDb(db);

  // Enrich with realtime (cache)
  const enriched = await enrichRowsWithRealtime(rows);

  // Re-sort by effective arrival time (estimated if available, otherwise scheduled)
  enriched.sort((a, b) =>
    (a.win_sec + (a.arrival_delay || 0)) - (b.win_sec + (b.arrival_delay || 0))
  );
  return enriched;
}
