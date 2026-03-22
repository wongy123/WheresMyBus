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


function applyRealtimeToRow(row, rt) {
  if (!rt) return row;

  // Try to match the correct stop update by stop_sequence first, else stop_id
  const seq = row.stop_sequence ?? row.stopSequence ?? null;

  let su = null;
  if (seq != null) {
    su = (rt.stopUpdates || []).find(u => Number(u.stopSequence) === Number(seq));
  }
  if (!su && row.stop_id) {
    su = (rt.stopUpdates || []).find(u => String(u.stopId) === String(row.stop_id));
  }

  const enriched = { ...row };

  // Vehicle position/identity (if available)
  if (rt.vehicle) {
    enriched.vehicle_latitude = rt.vehicle.latitude ?? null;
    enriched.vehicle_longitude = rt.vehicle.longitude ?? null;
    enriched.vehicle_id = rt.vehicle.vehicleId ?? null;
    enriched.vehicle_label = rt.vehicle.vehicleLabel ?? null;
    enriched.vehicle_current_stop_sequence = rt.vehicle.currentStopSequence ?? null;
    enriched.vehicle_timestamp = rt.vehicle.timestamp ?? null;
    enriched.vehicle_time_local = epochToLocalHms(rt.vehicle.timestamp);
  }

  // If we have any RT for this stop/trip, set the flag
  let appliedRT = false;

  if (su) {
    // delays
    if (su.arrivalDelay != null) {
      enriched.arrival_delay = su.arrivalDelay;
      appliedRT = true;
    }
    if (su.departureDelay != null) {
      enriched.departure_delay = su.departureDelay;
      appliedRT = true;
    }

    // Override "estimated_*" using delay or absolute time, preferring delay when present.
    // ARRIVAL
    if (su.arrivalDelay != null) {
      const schedSec = hmsToSec(enriched.scheduled_arrival_time);
      if (schedSec != null) {
        enriched.estimated_arrival_time = secToHms(schedSec + Number(su.arrivalDelay));
        appliedRT = true;
      }
    } else if (su.arrivalTime != null) {
      const hms = epochToHms(su.arrivalTime);
      if (hms) {
        enriched.estimated_arrival_time = hms;
        appliedRT = true;
      }
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
      if (hms) {
        enriched.estimated_departure_time = hms;
        appliedRT = true;
      }
    }
  }

  // Mark real_time_data if we applied any RT, or we at least had vehicle data
  if (appliedRT || rt.vehicle) {
    enriched.real_time_data = 1;
  }

  // No predicted_* fields — we intentionally omit them
  enriched.realtime_updated_at = rt.updatedAt ?? null;
  enriched.realtime_updated_local = epochMsToLocalHms(rt.updatedAt);
  return enriched;
}

async function enrichRowsWithRealtime(rows) {
  if (!rows?.length) return rows;

  // Group rows by trip_id to reduce cache lookups
  const byTrip = new Map();
  for (const r of rows) {
    const tripId = r.trip_id || r.tripId;
    if (!tripId) continue;
    if (!byTrip.has(tripId)) byTrip.set(tripId, []);
    byTrip.get(tripId).push(r);
  }

  const tripIds = [...byTrip.keys()];
  // IMPORTANT: use the same key function you used in the writer
  // If you already added tripKey(...) earlier in this file, keep using it.
  const lookups = await Promise.all(tripIds.map(id => cacheGet(tripKey(id))));
  const rtMap = new Map(tripIds.map((id, i) => [id, lookups[i]]));

  const out = [];
  for (const r of rows) {
    const t = r.trip_id || r.tripId;
    const rt = t ? rtMap.get(t) : null;
    out.push(applyRealtimeToRow(r, rt));
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
      SELECT stop_id, stop_name, location_type,
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
      SELECT stop_id, stop_name, location_type
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

  const sql = `
    SELECT stop_id, stop_name, stop_lat, stop_lon, location_type
    FROM stops
    WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
      AND (location_type IS NULL OR location_type IN (0, 1))
  `;

  const rows = db.prepare(sql).all();
  await closeDb(db);

  return rows
    .map(s => ({ ...s, distance_km: haversineKm(lat, lng, s.stop_lat, s.stop_lon) }))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);
}

export async function getStopsByRoute(routeId, direction = 0, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const sql = `
    SELECT st.stop_sequence, st.stop_id, s.stop_name, s.stop_code
    FROM stop_times st
    JOIN stops s ON st.stop_id = s.stop_id
    WHERE st.trip_id = (
      SELECT t.trip_id
      FROM trips t
      JOIN routes r ON t.route_id = r.route_id
      WHERE (t.route_id = $routeId OR r.route_short_name = $routeId)
        AND t.direction_id = $direction
      LIMIT 1
    )
    ORDER BY st.stop_sequence
  `;

  const stops = db.prepare(sql).all({ routeId, direction });
  await closeDb(db);
  return stops;
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
    se.arrival_time   AS scheduled_arrival_time,
    se.departure_time AS scheduled_departure_time,
    se.estimated_arrival_time,
    se.estimated_departure_time,
    se.arrival_delay,
    se.departure_delay,
    se.real_time_data,
    se.event_sec,
    se.win_sec
FROM stop_events_3day se
JOIN (
    SELECT trip_id, MIN(win_sec) AS next_win_sec
    FROM stop_events_3day
    WHERE (route_id = $routeId OR route_short_name = $routeId)
      AND direction_id = $direction
      AND win_sec BETWEEN $startSec AND $endSec
    GROUP BY trip_id
) nxt
  ON se.trip_id = nxt.trip_id
 AND se.win_sec = nxt.next_win_sec
JOIN (
    SELECT trip_id, win_sec, MIN(stop_sequence) AS min_seq
    FROM stop_events_3day
    WHERE (route_id = $routeId OR route_short_name = $routeId)
      AND direction_id = $direction
      AND win_sec BETWEEN $startSec AND $endSec
    GROUP BY trip_id, win_sec
) tb
  ON se.trip_id = tb.trip_id
 AND se.win_sec = tb.win_sec
 AND se.stop_sequence = tb.min_seq
ORDER BY se.win_sec ASC;
  `;

  const params = {
    routeId,
    direction,
    startSec: secNow,
    endSec: secEnd,
  };

  const rows = db.prepare(sql).all(params);
  await closeDb(db);

  // Enrich with realtime (cache)
  return enrichRowsWithRealtime(rows);
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
  return enrichRowsWithRealtime(rows);
}
