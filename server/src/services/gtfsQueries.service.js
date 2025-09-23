// src/services/gtfsQueries.service.js
import { closeDb, openDb, getStops, getStopTimeUpdates } from 'gtfs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cache } from '../lib/cache.js';
import crypto from 'node:crypto';


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
  const lookups = await Promise.all(tripIds.map(id => cache.get(tripKey(id))));
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

  let sql = `
    SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color
    FROM routes
  `;

  const params = {};
  if (searchTerm) {
    sql += ` WHERE route_short_name LIKE $term OR route_long_name LIKE $term `;
    params.term = `%${searchTerm}%`;
  }

  sql += ` ORDER BY route_short_name ASC `;

  const routes = db.prepare(sql).all(params);
  await closeDb(db);
  return routes;
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
  return route || null;
}

/* ---------------------------------- stops ---------------------------------- */

export async function getAllStops(searchTerm = '', configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  let sql = `
    SELECT stop_id, stop_name, location_type
    FROM stops
  `;

  const params = {};
  if (searchTerm) {
    sql += ` WHERE stop_name LIKE $term `;
    params.term = `%${searchTerm}%`;
  }

  sql += ` ORDER BY stop_name ASC `;

  const stops = db.prepare(sql).all(params);
  await closeDb(db);
  return stops;
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
    WHERE route_id = $routeId
      AND direction_id = $direction
      AND win_sec BETWEEN $startSec AND $endSec
    GROUP BY trip_id
) nxt
  ON se.trip_id = nxt.trip_id
 AND se.win_sec = nxt.next_win_sec
JOIN (
    SELECT trip_id, win_sec, MIN(stop_sequence) AS min_seq
    FROM stop_events_3day
    WHERE route_id = $routeId
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
