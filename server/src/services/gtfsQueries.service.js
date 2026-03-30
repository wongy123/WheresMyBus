// src/services/gtfsQueries.service.js
import { getStops, getStopTimeUpdates } from 'gtfs';
import { cacheGet } from './cache.service.js';
import { getLatestVehiclePositions } from './gtfsRealtime.service.js';
import crypto from 'node:crypto';
import { getLineNames } from '../utils/routeNames.js';
import { withDb } from '../utils/dbQuery.js';

const defaultConfigPath = '../../config.json';

/* ----------------------------- helpers: RT merge ---------------------------- */

// time helpers
function hmsToSec(hms) {
  if (!hms || typeof hms !== 'string') return null;
  const m = hms.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]), s = Number(m[3]);
  return h * 3600 + mi * 60 + s;
}

function normalizeHms(hms) {
  // Normalize GTFS overflow times (e.g. "24:50:00" → "00:50:00") for display.
  // Times within 0–23h are returned unchanged.
  const s = hmsToSec(hms);
  return (s != null && s >= 86400) ? secToHms(s) : hms;
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
  let suIsPreceding = false;
  if (seq != null) {
    su = (rt.stopUpdates || []).find(u => Number(u.stopSequence) === Number(seq));
  }
  if (!su && row.stop_id) {
    su = (rt.stopUpdates || []).find(u => String(u.stopId) === String(row.stop_id));
  }
  // GTFS-RT incremental feeds only include stops from the vehicle's current position onwards.
  // If no exact match, propagate delay from the closest preceding stop update.
  // Mark it as preceding so we only use delay-relative fields, not absolute timestamps
  // (an absolute departureTime from stop N would be wrong if applied to a later stop M).
  if (!su && seq != null && rt.stopUpdates?.length) {
    const preceding = rt.stopUpdates
      .filter(u => u.stopSequence != null && Number(u.stopSequence) < Number(seq))
      .sort((a, b) => Number(b.stopSequence) - Number(a.stopSequence));
    if (preceding.length) { su = preceding[0]; suIsPreceding = true; }
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
    } else if (su.arrivalTime != null && !suIsPreceding) {
      // Only use absolute timestamp from an exact-match update.
      // A preceding stop's arrivalTime belongs to that stop, not this one.
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
    } else if (su.departureTime != null && !suIsPreceding) {
      // Only use absolute timestamp from an exact-match update.
      // A preceding stop's departureTime belongs to that stop, not this one.
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
  const rtMap = new Map(tripIds.map((id, i) => [id, rtLookups[i]]));
  const vposMap = new Map(tripIds.map((id, i) => [id, vposLookups[i]]));

  const latestVposMap = getLatestVehiclePositions() || new Map();
  const fallbackVposByKey = new Map();
  for (const [_id, v] of latestVposMap.entries()) {
    const label = v?.vehicleLabel ? String(v.vehicleLabel).trim() : '';
    const routeId = v?.routeId ? String(v.routeId) : '';
    const direction = Number(v?.directionId);
    if (!label || !routeId || !Number.isFinite(direction)) continue;
    const family = routeId.split('-')[0];
    if (!family) continue;
    fallbackVposByKey.set(`${family}|${direction}|${label}`, v);
  }

  function rowTripLabel(row) {
    const tripId = String(row.trip_id || row.tripId || '');
    if (!tripId) return '';
    const i = tripId.lastIndexOf('-');
    return i >= 0 ? tripId.slice(i + 1) : '';
  }

  function fallbackVposForRow(row) {
    // Restrict fallback to rail services where vehicle label is stable and
    // encoded in scheduled trip IDs (e.g. ...-DM51).
    if (!(row.route_type === 1 || row.route_type === 2 || row.route_type === 12)) return null;
    const label = rowTripLabel(row);
    if (!label) return null;
    const family = row.route_short_name || (row.route_id ? String(row.route_id).split('-')[0] : '');
    const direction = Number(row.direction_id);
    if (!family || !Number.isFinite(direction)) return null;
    return fallbackVposByKey.get(`${family}|${direction}|${label}`) || null;
  }

  const out = [];
  for (const r of rows) {
    const t = r.trip_id || r.tripId;
    const directVpos = t ? vposMap.get(t) : null;
    const fallbackVpos = !directVpos ? fallbackVposForRow(r) : null;
    out.push(applyRealtimeToRow(r, t ? rtMap.get(t) : null, directVpos || fallbackVpos));
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

  const rows = await withDb(db => db.prepare(sql).all(), configPath);

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
      const sn = (r.route_short_name || '').toLowerCase();
      const ln = (r.route_long_name || '').toLowerCase();
      const lineName = (r.line_name || '').toLowerCase();

      const allTokensMatch = tokens.every(t => sn.includes(t) || ln.includes(t) || lineName.includes(t));
      if (!allTokensMatch) return null;

      let rank;
      if (sn === q) rank = 0;
      else if (sn.startsWith(q)) rank = 1;
      else if (ln.startsWith(q)) rank = 2;
      else if (lineName.startsWith(q)) rank = 3;
      else if (sn.includes(q)) rank = 4;
      else if (ln.includes(q)) rank = 5;
      else if (lineName.includes(q)) rank = 6;
      else rank = 7;

      return { ...r, sort_rank: rank };
    })
    .filter(Boolean)
    .sort((a, b) => a.sort_rank - b.sort_rank || a.route_short_name.localeCompare(b.route_short_name));

  return scored;
}

export async function getOneRoute(identifier, configPath = defaultConfigPath) {
  const sql = `
    SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color
    FROM routes
    WHERE route_id = $id OR route_short_name = $id
    LIMIT 1
  `;

  const route = await withDb(db => db.prepare(sql).get({ id: identifier }), configPath);
  if (!route) return null;
  return { ...route, line_name: getLineNames(route.route_short_name).join(' / ') || null };
}

async function resolveRouteFamily(identifier, configPath = defaultConfigPath) {
  const route = await withDb(db => db.prepare(`
    SELECT route_id, route_short_name
    FROM routes
    WHERE route_id = $id OR route_short_name = $id
    LIMIT 1
  `).get({ id: identifier }), configPath);

  return {
    routeId: route?.route_id || identifier,
    routeShortName: route?.route_short_name || identifier,
  };
}

/* ---------------------------------- stops ---------------------------------- */

export async function getAllStops(searchTerm = '', configPath = defaultConfigPath) {
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
      ORDER BY sort_rank ASC, (location_type != 1) ASC, stop_name ASC
    `;
    params = {
      ...tokenParams,
      fullPrefix: `${searchTerm}%`,
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

  return withDb(db => db.prepare(sql).all(params), configPath);
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
  return withDb(db => {
    const rows = db.prepare(`
      SELECT stop_id, stop_name, stop_lat, stop_lon, location_type
      FROM stops
      WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
        AND (location_type IS NULL OR location_type IN (0, 1))
        AND parent_station IS NULL
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

    return topN;
  }, configPath);
}

export async function getStopsInBounds(north, south, east, west, types = null, limit = 750, configPath = defaultConfigPath) {
  return withDb(db => {
    const hasTypes = types && types.length > 0;
    const typeFilter = hasTypes
      ? `AND COALESCE(srt.primary_route_type, 3) IN (${types.map(() => '?').join(',')})`
      : '';
    return db.prepare(`
      SELECT s.stop_id, s.stop_name, s.stop_code, s.stop_lat, s.stop_lon, s.location_type,
        COALESCE(srt.primary_route_type, 3) AS primary_route_type
      FROM stops s
      LEFT JOIN stop_route_type srt ON srt.stop_id = s.stop_id
      WHERE s.stop_lat IS NOT NULL AND s.stop_lon IS NOT NULL
        AND (s.location_type IS NULL OR s.location_type IN (0, 1))
        AND s.stop_lat BETWEEN ? AND ?
        AND s.stop_lon BETWEEN ? AND ?
        ${typeFilter}
      LIMIT ?
    `).all(south, north, west, east, ...(hasTypes ? types : []), limit);
  }, configPath);
}

export async function getStopPlatforms(stationId, configPath = defaultConfigPath) {
  return withDb(db => db.prepare(`
    SELECT stop_id, stop_name, stop_code, stop_lat, stop_lon, platform_code
    FROM stops
    WHERE parent_station = $stationId
    ORDER BY stop_name
  `).all({ stationId }), configPath);
}

export async function getRouteDirections(routeId, configPath = defaultConfigPath) {
  const family = await resolveRouteFamily(routeId, configPath);
  const rows = await withDb(db => db.prepare(`
    SELECT DISTINCT t.direction_id
    FROM trips t
    JOIN routes r ON t.route_id = r.route_id
    WHERE (t.route_id = $routeId OR r.route_short_name = $routeShortName)
      AND t.direction_id IN (0, 1)
    ORDER BY t.direction_id
  `).all(family), configPath);

  return rows
    .map(row => row.direction_id)
    .filter(direction => direction === 0 || direction === 1);
}

export async function getStopsByRoute(routeId, direction = 0, configPath = defaultConfigPath) {
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
      ORDER BY (SELECT MAX(stop_sequence) FROM stop_times WHERE trip_id = t.trip_id) DESC
      LIMIT 1
    )
    ORDER BY st.stop_sequence
  `;

  const rows = await withDb(db => db.prepare(sql).all({ routeId, direction }), configPath);
  if (rows.length > 0) return rows;
  const altDir = direction === 0 ? 1 : 0;
  return withDb(db => db.prepare(sql).all({ routeId, direction: altDir }), configPath);
}

export async function getRouteShape(routeId, direction = 0, configPath = defaultConfigPath) {
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
      ORDER BY (SELECT MAX(stop_sequence) FROM stop_times WHERE trip_id = t.trip_id) DESC
      LIMIT 1
    )
    ORDER BY sh.shape_pt_sequence
  `;

  const rows = await withDb(db => db.prepare(sql).all({ routeId, direction }), configPath);
  if (rows.length > 0) return rows;
  const altDir = direction === 0 ? 1 : 0;
  return withDb(db => db.prepare(sql).all({ routeId, direction: altDir }), configPath);
}

export async function getRouteSchedule(routeId, direction = 0, configPath = defaultConfigPath) {
  const family = await resolveRouteFamily(routeId, configPath);
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
    JOIN trips t ON st.trip_id = t.trip_id
    JOIN routes r ON t.route_id = r.route_id
    WHERE (t.route_id = $routeId OR r.route_short_name = $routeShortName)
    AND st.direction_id = $direction
    ORDER BY st.trip_id, st.stop_sequence
  `;

  const rows = await withDb(db => db.prepare(sql).all({ ...family, direction }), configPath);

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
  // One row per route_short_name; only routes that actually serve this stop
  const sql = `
    SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_type, r.route_color, r.route_text_color
    FROM routes r
    INNER JOIN (
      SELECT DISTINCT t.route_id
      FROM stop_times st
      JOIN trips t ON st.trip_id = t.trip_id
      WHERE st.stop_id = $stopId
        OR st.stop_id IN (SELECT stop_id FROM stops WHERE parent_station = $stopId)
    ) serving ON r.route_id = serving.route_id
    INNER JOIN (
      SELECT route_short_name, MIN(route_id) AS min_id
      FROM routes
      GROUP BY route_short_name
    ) dedup ON r.route_id = dedup.min_id
    ORDER BY r.route_short_name
  `;

  return withDb(db => db.prepare(sql).all({ stopId }), configPath);
}

export async function getOneStop(stopId, configPath = defaultConfigPath) {
  return withDb(_db => {
    const stop = getStops({ stop_id: stopId });
    return stop[0];
  }, configPath);
}

export async function getAllStopTimeUpdates(configPath = defaultConfigPath) {
  // NOTE: With stateless RT (cache-backed), this will usually be empty/unused.
  return withDb(_db => getStopTimeUpdates(), configPath);
}

/* ------------------------ upcoming (with RT enrichment) --------------------- */

export async function getUpcomingByRoute(
  routeId,
  direction = 0,
  startTime = Math.floor(Date.now() / 1000), // epoch seconds
  duration = 7200,                           // 2 hours
  configPath = defaultConfigPath
) {
  const family = await resolveRouteFamily(routeId, configPath);
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
  WHERE (route_id = $routeId OR route_short_name = $routeShortName)
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

  // Include a lookback window so vehicles that are running late (GPS present
  // but no trip-update delay, so win_sec is in the past) are still surfaced.
  // Matches the MAX_OVERDUE_SEC lookback used by getUpcomingByStop.
  const MAX_LOOKBACK_SEC = 3600;
  const params = {
    ...family,
    direction,
    startSec: secNow - MAX_LOOKBACK_SEC,
    endSec: secEnd,
  };

  const rows = await withDb(db => db.prepare(sql).all(params), configPath);

  // Enrich with realtime (cache) then re-sort by effective time
  const enriched = await enrichRowsWithRealtime(rows);
  enriched.sort((a, b) =>
    (a.win_sec + (a.arrival_delay || 0)) - (b.win_sec + (b.arrival_delay || 0))
  );

  // Find trips where the vehicle position disagrees with the time-window result.
  //
  // staleByTrip  (veh_seq > seq): vehicle has physically passed the displayed
  //   stop — the trip-update was applied but the time window still returned an
  //   earlier stop.  Advance to veh_seq.
  //
  // behindByTrip (veh_seq < seq): the time window has jumped ahead of the
  //   vehicle — the trip-update delay is stale/underestimated so the estimated
  //   arrival for intermediate stops has already fallen below secNow even though
  //   the bus hasn't physically reached them.  Step back to veh_seq, capped at
  //   MAX_OVERDUE_SEC seconds past secNow to avoid showing very old stops.
  const MAX_OVERDUE_SEC = 480; // 8 minutes
  const staleByTrip = new Map();
  const behindByTrip = new Map();
  for (const r of enriched) {
    const vseq = r.vehicle_current_stop_sequence;
    // 0 is the protobuf default (field not set); treat as unknown, not sequence 0
    if (vseq == null || vseq === 0) continue;
    if (vseq > r.stop_sequence) {
      staleByTrip.set(r.trip_id, vseq);
    } else if (vseq < r.stop_sequence) {
      behindByTrip.set(r.trip_id, vseq);
    }
  }

  const stopSelectSql = `
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
  `;

  const needsReplacement = staleByTrip.size > 0 || behindByTrip.size > 0;
  if (!needsReplacement) {
    let visible = _filterActiveVehicles(enriched, secNow);
    visible = await injectUnplannedRailRows(visible, {
      routeShortName: family.routeShortName,
      direction,
      secNow,
      endSec: secEnd,
      configPath,
    });
    visible.sort((a, b) =>
      (a.win_sec + (a.arrival_delay || 0)) - (b.win_sec + (b.arrival_delay || 0))
    );
    return visible;
  }

  const replacements = await withDb(db => {
    const out = [];

    for (const [tripId, currentSeq] of staleByTrip) {
      const next = db.prepare(stopSelectSql + `
        WHERE trip_id = $tripId
          AND stop_sequence >= $currentSeq
          AND win_sec BETWEEN $startSec AND $endSec
        ORDER BY stop_sequence ASC
        LIMIT 1
      `).get({ tripId, currentSeq, startSec: secNow, endSec: secEnd });
      if (next) out.push(next);
    }

    for (const [tripId, currentSeq] of behindByTrip) {
      const prev = db.prepare(stopSelectSql + `
        WHERE trip_id = $tripId
          AND stop_sequence = $currentSeq
          AND event_sec >= $minSec
        LIMIT 1
      `).get({ tripId, currentSeq, minSec: secNow - MAX_OVERDUE_SEC });
      if (prev) out.push(prev);
    }

    return out;
  }, configPath);

  const replacementsEnriched = await enrichRowsWithRealtime(replacements);
  const replacedTrips = new Set([...staleByTrip.keys(), ...behindByTrip.keys()]);
  const result = [
    ...enriched.filter(r => !replacedTrips.has(r.trip_id)),
    ...replacementsEnriched,
  ];
  let visible = _filterActiveVehicles(result, secNow);
  visible = await injectUnplannedRailRows(visible, {
    routeShortName: family.routeShortName,
    direction,
    secNow,
    endSec: secEnd,
    configPath,
  });
  visible.sort((a, b) =>
    (a.win_sec + (a.arrival_delay || 0)) - (b.win_sec + (b.arrival_delay || 0))
  );
  return visible;
}

// Keep a row if it's in the normal future window, or if GPS confirms the
// vehicle hasn't yet passed this stop (late-running, no trip-update delay).
// Drops overdue rows with no GPS evidence of being still active.
function _filterActiveVehicles(rows, secNow) {
  return rows.filter(r => {
    if (r.win_sec >= secNow) return true;
    if (r.vehicle_current_stop_sequence != null) {
      return r.vehicle_current_stop_sequence <= r.stop_sequence;
    }
    return false;
  });
}

async function injectUnplannedRailRows(rows, {
  routeShortName = null,
  direction = null,
  stopIds = null,
  secNow,
  endSec,
  configPath = defaultConfigPath,
}) {
  const vposMap = getLatestVehiclePositions();
  if (!vposMap || vposMap.size === 0) return rows;

  const vehicles = await getVehiclePositionsWithRoutes(vposMap, configPath);
  if (!vehicles.length) return rows;

  const stopIdSet = stopIds ? new Set(stopIds.map(String)) : null;
  const existingKeys = new Set(rows.map(r => {
    // For rail trips the vehicle label is encoded in the scheduled trip_id suffix
    // (e.g. "35884990-QR 25_26-41757-DM51" → "DM51").  Use it as the dedup key
    // so we don't inject an unplanned row when the scheduled counterpart is present
    // but hasn't been enriched with vehicle_label yet.
    const isRail = r.route_type === 1 || r.route_type === 2 || r.route_type === 12;
    const labelFromTripId = isRail && r.trip_id
      ? (() => { const s = String(r.trip_id); const i = s.lastIndexOf('-'); return i >= 0 ? s.slice(i + 1) : ''; })()
      : '';
    const keyId = r.vehicle_label || labelFromTripId || r.vehicle_id || r.trip_id;
    return `${r.route_short_name}|${r.direction_id}|${keyId}`;
  }));

  const candidates = vehicles.filter(v => {
    if (!String(v.trip_id || '').startsWith('UNPLANNED-')) return false;
    if (!(v.route_type === 1 || v.route_type === 2 || v.route_type === 12)) return false;
    if (routeShortName && v.route_short_name !== routeShortName) return false;
    if (direction != null && Number(v.direction_id) !== Number(direction)) return false;
    if (stopIdSet && (!v.stop_id || !stopIdSet.has(String(v.stop_id)))) return false;
    if (v.minutes_away == null) return false;
    const targetSec = secNow + Math.max(0, Number(v.minutes_away)) * 60;
    return targetSec <= endSec;
  });

  const injected = [];
  for (const v of candidates) {
    const keyId = v.vehicle_label || v.vehicle_id || v.trip_id;
    const key = `${v.route_short_name}|${v.direction_id}|${keyId}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    const targetSec = secNow + Math.max(0, Number(v.minutes_away || 0)) * 60;
    const eta = secToHms(targetSec);

    injected.push({
      route_id: v.route_id,
      route_short_name: v.route_short_name,
      route_color: v.route_color,
      route_text_color: v.route_text_color,
      route_type: v.route_type,
      service_id: null,
      trip_id: v.trip_id,
      trip_headsign: v.trip_headsign || '',
      direction_id: v.direction_id,
      stop_id: v.stop_id || null,
      stop_code: null,
      stop_name: v.stop_name || null,
      stop_sequence: v.stop_sequence || null,
      scheduled_arrival_time: eta,
      scheduled_departure_time: eta,
      estimated_arrival_time: eta,
      estimated_departure_time: eta,
      arrival_delay: null,
      departure_delay: null,
      real_time_data: 1,
      event_sec: targetSec,
      win_sec: targetSec,
      vehicle_latitude: v.lat,
      vehicle_longitude: v.lon,
      vehicle_id: v.vehicle_id || null,
      vehicle_label: v.vehicle_label || null,
      vehicle_current_stop_sequence: v.vehicle_current_stop_sequence ?? null,
      vehicle_timestamp: v.timestamp || null,
      vehicle_time_local: epochToLocalHms(v.timestamp),
    });
  }

  return rows.concat(injected);
}

export async function getUpcomingByStop(
  stopId,
  startTime = Math.floor(Date.now() / 1000), // epoch seconds (defaults to now)
  duration = 7200,                           // 2 hours
  configPath = defaultConfigPath
) {
  // Convert startTime (epoch seconds) -> seconds since local midnight
  const date = new Date(startTime * 1000);
  const midnight = new Date(date);
  midnight.setHours(0, 0, 0, 0);
  const startSec = Math.floor((date - midnight) / 1000);
  const endSec = startSec + duration;
  // Look back up to 60 minutes so late-running buses whose scheduled departure
  // has passed are still surfaced. The GPS filter below keeps only buses that
  // haven't yet reached this stop, so the larger window doesn't cause false positives.
  const MAX_OVERDUE_SEC = 3600;
  const overdueSec = startSec - MAX_OVERDUE_SEC;

  const sql = `
    SELECT
      se.route_id,
      se.route_short_name,
      se.route_color,
      se.route_text_color,
      se.route_type,
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
      AND se.win_sec BETWEEN $overdueSec AND $endSec
    ORDER BY se.win_sec, se.route_short_name, se.trip_id, se.stop_sequence
  `;

  const params = {
    stopId: String(stopId),
    startSec,
    endSec,
    overdueSec,
  };

  const rows = await withDb(db => db.prepare(sql).all(params), configPath);

  // Enrich with realtime (cache)
  const enriched = await enrichRowsWithRealtime(rows);

  // Keep a row if:
  //   - scheduled in the normal future window (win_sec >= startSec), OR
  //   - in the overdue back-window: GPS confirms the vehicle hasn't yet passed
  //     this stop (late bus still approaching). Rows without GPS data are dropped
  //     from the overdue window to avoid surfacing cancelled/completed services.
  let visible = enriched.filter(r => {
    if (r.vehicle_current_stop_sequence != null) {
      return r.vehicle_current_stop_sequence <= r.stop_sequence;
    }
    return r.win_sec >= startSec;
  });
  visible = await injectUnplannedRailRows(visible, {
    stopIds: [String(stopId)],
    secNow: startSec,
    endSec,
    configPath,
  });

  // Sort by the same effective time the client displays (dep preferred over arr).
  // arrival_delay is the vehicle's delay at its *current GPS stop*, not at this
  // stop, so using it as an offset produces wrong sort keys for future buses.
  const effectiveSec = r => {
    const t = r.estimated_departure_time || r.estimated_arrival_time ||
      r.scheduled_departure_time || r.scheduled_arrival_time;
    if (!t) return r.win_sec;
    const parts = t.split(':');
    let s = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2] || 0);
    // secToHms wraps past-midnight times to 00:xx; if the result is more than
    // 12 hours behind win_sec the time has wrapped — add 86400 to restore it.
    if (r.win_sec - s > 43200) s += 86400;
    return s;
  };
  visible.sort((a, b) => effectiveSec(a) - effectiveSec(b));
  // Normalize GTFS overflow scheduled times for display (e.g. "24:50:00" → "00:50:00")
  for (const r of visible) {
    r.scheduled_arrival_time = normalizeHms(r.scheduled_arrival_time);
    r.scheduled_departure_time = normalizeHms(r.scheduled_departure_time);
  }
  return visible;
}

export async function getUpcomingByStation(
  stationId,
  startTime = Math.floor(Date.now() / 1000),
  duration = 7200,
  configPath = defaultConfigPath
) {
  const platforms = await getStopPlatforms(stationId, configPath);

  // Not a station (no child platforms) — fall back to regular stop query
  if (!platforms.length) {
    return getUpcomingByStop(stationId, startTime, duration, configPath);
  }

  const date = new Date(startTime * 1000);
  const midnight = new Date(date);
  midnight.setHours(0, 0, 0, 0);
  const startSec = Math.floor((date - midnight) / 1000);
  const endSec = startSec + duration;
  const MAX_OVERDUE_SEC = 3600;
  const overdueSec = startSec - MAX_OVERDUE_SEC;

  const platformIds = platforms.map(p => String(p.stop_id));
  const platformCodeMap = Object.fromEntries(platforms.map(p => [String(p.stop_id), p.platform_code]));
  const placeholders = platformIds.map(() => '?').join(', ');

  const sql = `
    SELECT
      se.route_id,
      se.route_short_name,
      se.route_color,
      se.route_text_color,
      se.route_type,
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
    WHERE se.stop_id IN (${placeholders})
      AND se.win_sec BETWEEN ? AND ?
    ORDER BY se.win_sec, se.route_short_name, se.trip_id, se.stop_sequence
  `;

  const rows = await withDb(db => db.prepare(sql).all(...platformIds, overdueSec, endSec), configPath);

  rows.forEach(r => {
    r.platform_code = platformCodeMap[String(r.stop_id)] ?? null;
    // Clear view-precomputed estimated times so stale SQLite RT data doesn't
    // bleed through. enrichRowsWithRealtime will re-apply fresh Redis values;
    // trips with no current Redis entry fall back to scheduled times.
    r.estimated_arrival_time = null;
    r.estimated_departure_time = null;
    r.arrival_delay = null;
    r.departure_delay = null;
    r.real_time_data = 0;
  });

  const enriched = await enrichRowsWithRealtime(rows);
  let visible = enriched.filter(r => {
    if (r.vehicle_current_stop_sequence != null) {
      return r.vehicle_current_stop_sequence <= r.stop_sequence;
    }
    return r.win_sec >= startSec;
  });
  visible = await injectUnplannedRailRows(visible, {
    stopIds: platformIds,
    secNow: startSec,
    endSec,
    configPath,
  });
  const effectiveSecStn = r => {
    const t = r.estimated_departure_time || r.estimated_arrival_time ||
      r.scheduled_departure_time || r.scheduled_arrival_time;
    if (!t) return r.win_sec;
    const parts = t.split(':');
    let s = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2] || 0);
    // secToHms wraps past-midnight times to 00:xx; if the result is more than
    // 12 hours behind win_sec the time has wrapped — add 86400 to restore it.
    if (r.win_sec - s > 43200) s += 86400;
    return s;
  };
  visible.sort((a, b) => effectiveSecStn(a) - effectiveSecStn(b));
  // Normalize GTFS overflow scheduled times for display (e.g. "24:50:00" → "00:50:00")
  for (const r of visible) {
    r.scheduled_arrival_time = normalizeHms(r.scheduled_arrival_time);
    r.scheduled_departure_time = normalizeHms(r.scheduled_departure_time);
  }
  return visible;
}

/* ----------------------- live vehicle positions ---------------------------- */

export async function getVehiclePositionsWithRoutes(vposMap, configPath = defaultConfigPath) {
  if (!vposMap || vposMap.size === 0) return [];
  const tripIds = Array.from(vposMap.keys());

  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const secNow = Math.floor((now - midnight) / 1000);

  const placeholders = tripIds.map(() => '?').join(',');
  const { tripRows, fallbackRows, stopEventRows } = await withDb(db => {
    const tripRows = db.prepare(`
      SELECT t.trip_id, t.route_id, COALESCE(t.direction_id, 0) AS direction_id,
             t.trip_headsign,
             r.route_short_name, r.route_color, r.route_text_color,
             COALESCE(r.route_type, 3) AS route_type
      FROM trips t
      JOIN routes r ON r.route_id = t.route_id
      WHERE t.trip_id IN (${placeholders})
    `).all(...tripIds);

    // For trips not in static GTFS (e.g. UNPLANNED/ADDED services), fall back to
    // looking up the route directly using the routeId from the RT feed.
    const foundTripIds = new Set(tripRows.map(r => r.trip_id));
    const missingTripIds = tripIds.filter(id => !foundTripIds.has(id));
    const fallbackRows = [];
    if (missingTripIds.length > 0) {
      const fallbackRouteIds = [...new Set(
        missingTripIds.map(tid => vposMap.get(tid)?.routeId).filter(Boolean)
      )];
      if (fallbackRouteIds.length > 0) {
        const fbPlaceholders = fallbackRouteIds.map(() => '?').join(',');
        const routeRows = db.prepare(`
          SELECT r.route_id, r.route_short_name, r.route_color, r.route_text_color,
                 COALESCE(r.route_type, 3) AS route_type,
                 MIN(t.direction_id) AS min_dir,
                 MAX(t.direction_id) AS max_dir
          FROM routes r
          LEFT JOIN trips t ON t.route_id = r.route_id
          WHERE r.route_id IN (${fbPlaceholders})
          GROUP BY r.route_id
        `).all(...fallbackRouteIds);
        const routeMap = new Map(routeRows.map(r => [r.route_id, r]));
        for (const tripId of missingTripIds) {
          const vpos = vposMap.get(tripId);
          if (!vpos?.routeId) continue;
          const route = routeMap.get(vpos.routeId);
          if (!route) continue;
          // Trust the RT direction_id only if it's non-zero (explicitly set, not the
          // protobuf uint32 default) and that direction exists for this route in GTFS.
          // Otherwise fall back to the route's actual direction from the trips table.
          const rtDir = vpos.directionId;
          const onlyOneDir = route.min_dir === route.max_dir;
          const direction_id = (rtDir && (rtDir === route.min_dir || rtDir === route.max_dir))
            ? rtDir
            : (onlyOneDir ? route.min_dir : 0);

          let scheduleTripId = null;
          let scheduleHeadsign = '';
          if ((route.route_type === 1 || route.route_type === 2 || route.route_type === 12) && vpos.vehicleLabel) {
            const matchedTrip = db.prepare(`
              SELECT trip_id, trip_headsign
              FROM stop_events_3day
              WHERE route_short_name = $routeShortName
                AND direction_id = $directionId
                AND trip_id LIKE $tripSuffix
              ORDER BY ABS(win_sec - $targetSec) ASC, stop_sequence ASC
              LIMIT 1
            `).get({
              routeShortName: route.route_short_name,
              directionId: direction_id,
              tripSuffix: '%-' + vpos.vehicleLabel,
              targetSec: secNow,
            });
            if (matchedTrip) {
              scheduleTripId = matchedTrip.trip_id;
              scheduleHeadsign = matchedTrip.trip_headsign || '';
            }
          }

          fallbackRows.push({
            trip_id: tripId,
            route_id: route.route_id,
            direction_id,
            trip_headsign: scheduleHeadsign,
            route_short_name: route.route_short_name,
            route_color: route.route_color,
            route_text_color: route.route_text_color,
            route_type: route.route_type,
            schedule_trip_id: scheduleTripId,
          });
        }
      }
    }

    const stopEventTripIds = [...new Set([
      ...tripRows.map(row => row.trip_id),
      ...fallbackRows.map(row => row.schedule_trip_id || row.trip_id),
    ])];
    const stopEventPlaceholders = stopEventTripIds.map(() => '?').join(',');
    const stopEventRows = db.prepare(`
      SELECT
        trip_id,
        stop_id,
        stop_name,
        stop_sequence,
        win_sec,
        arrival_time AS scheduled_arrival_time,
        departure_time AS scheduled_departure_time,
        estimated_arrival_time,
        estimated_departure_time
      FROM stop_events_3day
      WHERE trip_id IN (${stopEventPlaceholders})
    `).all(...stopEventTripIds);

    return { tripRows, fallbackRows, stopEventRows };
  }, configPath);

  function eventTimeSec(row) {
    const time = row.estimated_departure_time || row.estimated_arrival_time ||
      row.scheduled_departure_time || row.scheduled_arrival_time;
    if (time) {
      const sec = hmsToSec(time);
      if (sec != null) return sec % 86400;
    }
    return row.win_sec != null ? Number(row.win_sec) : null;
  }

  function adjustedEventSec(row) {
    const sec = eventTimeSec(row);
    if (sec == null) return Number.POSITIVE_INFINITY;
    return sec < (secNow - 1800) ? sec + 86400 : sec;
  }

  function pickNextStop(rows, currentStopSequence) {
    if (!rows || rows.length === 0) return null;

    const annotated = rows.map(row => ({
      ...row,
      _adjustedSec: adjustedEventSec(row),
    }));

    // Prefer stops that are still upcoming or effectively current, rather than
    // stale earlier stops in the same trip which would produce 23h-style ETAs.
    var candidates = annotated.filter(row => row._adjustedSec >= (secNow - 60));
    if (!candidates.length) candidates = annotated;

    if (currentStopSequence != null && currentStopSequence > 0) {
      const bySequence = candidates.filter(row => row.stop_sequence >= currentStopSequence);
      if (bySequence.length) candidates = bySequence;
    }

    candidates.sort((a, b) => a._adjustedSec - b._adjustedSec || a.stop_sequence - b.stop_sequence);
    return candidates[0] || null;
  }

  const stopEventMap = new Map();
  for (const row of stopEventRows) {
    if (!stopEventMap.has(row.trip_id)) stopEventMap.set(row.trip_id, []);
    stopEventMap.get(row.trip_id).push(row);
  }

  const allRows = [...tripRows, ...fallbackRows];
  return allRows.map(row => {
    const vpos = vposMap.get(row.trip_id);
    if (!vpos?.latitude || !vpos?.longitude) return null;
    const referenceTripId = row.schedule_trip_id || row.trip_id;
    const nextStop = pickNextStop(stopEventMap.get(referenceTripId), vpos.currentStopSequence ?? null);
    const minutesAway = nextStop
      ? Math.max(0, Math.round((nextStop._adjustedSec - secNow) / 60))
      : null;
    return {
      trip_id: row.trip_id,
      route_id: row.route_id,
      direction_id: row.direction_id,
      trip_headsign: row.trip_headsign || '',
      route_short_name: row.route_short_name || '',
      route_color: row.route_color || null,
      route_text_color: row.route_text_color || null,
      route_type: row.route_type,
      lat: vpos.latitude,
      lon: vpos.longitude,
      vehicle_id: vpos.vehicleId || null,
      vehicle_label: vpos.vehicleLabel || null,
      timestamp: vpos.timestamp || null,
      stop_id: nextStop?.stop_id || null,
      stop_name: nextStop?.stop_name || null,
      stop_sequence: nextStop?.stop_sequence || null,
      vehicle_current_stop_sequence: vpos.currentStopSequence ?? null,
      minutes_away: minutesAway,
    };
  }).filter(Boolean);
}
