// src/services/gtfsQueries.service.js
import { getStops, getStopTimeUpdates } from 'gtfs';
import { cacheGet } from './cache.service.js';
import { getLatestVehiclePositions } from './gtfsRealtime.service.js';
import crypto from 'node:crypto';
import { getLineNames } from '../utils/routeNames.js';
import { withDb } from '../utils/dbQuery.js';

const defaultConfigPath = '../../config.json';

// Vehicle GPS positions older than this are considered stale and not trusted
// for overdue-stop filtering (second safeguard after trip-update check).
const STALE_GPS_SEC = 300; // 5 minutes
// Trips with minutes_away beyond this threshold are almost certainly ghosts
// (completed trips whose schedule time wraps to the next day via adjustedEventSec).
const MAX_MINUTES_AWAY = 90;

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

function epochToHms(epochSeconds, tzOffsetHours = 10) {
  if (epochSeconds == null) return null;
  const d = new Date(Number(epochSeconds) * 1000);
  const local = new Date(d.getTime() + tzOffsetHours * 3600 * 1000);
  return secToHms(local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds());
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


// Haversine distance in meters between two lat/lon pairs.
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// For vehicles whose GTFS-RT currentStopSequence=1 is bogus (vehicle is >2km from
// stop 1), the RT delay is anchored to the wrong position and produces stale ETAs.
// This function recomputes estimated times using the vehicle's actual GPS position:
//   real_delay = secNow - scheduled_dep(nearest_gps_stop)
//   estimated_dep(target_stop) = scheduled_dep(target_stop) + real_delay
// Only applied when GPS-derived delay is materially lower than RT delay (>=5 min diff),
// ensuring we don't override genuinely late buses.
async function applyGpsCorrectedDelays(rows, secNow, configPath) {
  const epochNow = Math.floor(Date.now() / 1000);

  // Collect trips that may have bogus seq=1 (GPS fresh, vpos_seq=1, has coordinates)
  const candidateTrips = new Map(); // trip_id -> {lat, lon, rt_delay}
  for (const r of rows) {
    if (r.vehicle_current_stop_sequence !== 1) continue;
    if (!r.vehicle_latitude || !r.vehicle_longitude) continue;
    if (!r.vehicle_timestamp || (epochNow - r.vehicle_timestamp) > STALE_GPS_SEC) continue;
    if (candidateTrips.has(r.trip_id)) continue;
    const rtDelay = r.departure_delay ?? r.arrival_delay ?? null;
    candidateTrips.set(r.trip_id, {
      lat: Number(r.vehicle_latitude),
      lon: Number(r.vehicle_longitude),
      rtDelay,
    });
  }
  if (candidateTrips.size === 0) return;

  // Load all stop coords + scheduled times for candidate trips in one query
  const tripIds = [...candidateTrips.keys()];
  const stopTimes = await withDb(db => {
    const ph = tripIds.map(() => '?').join(',');
    return db.prepare(`
      SELECT st.trip_id, st.stop_sequence, st.departure_time, s.stop_lat, s.stop_lon
      FROM stop_times st
      JOIN stops s ON s.stop_id = st.stop_id
      WHERE st.trip_id IN (${ph})
      ORDER BY st.trip_id, st.stop_sequence
    `).all(...tripIds);
  }, configPath);

  // Group by trip
  const byTrip = new Map();
  for (const st of stopTimes) {
    if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
    byTrip.get(st.trip_id).push(st);
  }

  // Compute GPS-corrected delay per trip
  const gpsCorrectedDelay = new Map(); // trip_id -> real_delay_seconds
  for (const [tripId, gps] of candidateTrips) {
    const stops = byTrip.get(tripId);
    if (!stops?.length) continue;

    // Check distance to stop 1 — if within 2km, seq=1 is plausible, skip
    const stop1 = stops.find(s => s.stop_sequence === 1);
    if (!stop1 || stop1.stop_lat == null) continue;
    // Depot bus protection: if trip hasn't started yet, bus is at depot/layover — skip correction
    const stop1Sec = hmsToSec(stop1.departure_time);
    if (stop1Sec != null && stop1Sec > secNow) continue;
    const dist1 = haversineM(gps.lat, gps.lon, Number(stop1.stop_lat), Number(stop1.stop_lon));
    if (dist1 <= 2000) continue;

    // Find nearest stop to GPS
    let nearest = null, nearestDist = Infinity;
    for (const s of stops) {
      if (s.stop_lat == null || s.stop_lon == null) continue;
      const d = haversineM(gps.lat, gps.lon, Number(s.stop_lat), Number(s.stop_lon));
      if (d < nearestDist) { nearestDist = d; nearest = s; }
    }
    if (!nearest) continue;

    const schedSec = hmsToSec(nearest.departure_time);
    if (schedSec == null) continue;

    // Sanity check: nearest GPS stop must be in the past — bus should have reached it.
    // If nearest stop is still in the future, the bus is likely a depot vehicle whose GPS
    // happens to be near a future stop on the route (e.g. parked in the CBD).
    if (schedSec > secNow) continue;

    const realDelay = secNow - schedSec;

    // Only substitute if GPS-derived delay is materially less than RT delay (5+ min diff).
    // If the bus is genuinely late, keep the RT delay.
    const MIN_IMPROVEMENT_SEC = 300;
    if (gps.rtDelay != null && (gps.rtDelay - realDelay) < MIN_IMPROVEMENT_SEC) continue;

    gpsCorrectedDelay.set(tripId, realDelay);
  }

  // Apply corrected delay to all rows for affected trips
  for (const r of rows) {
    const corrected = gpsCorrectedDelay.get(r.trip_id);
    if (corrected == null) continue;
    const schedDep = hmsToSec(r.scheduled_departure_time);
    if (schedDep != null) {
      r.estimated_departure_time = secToHms(schedDep + corrected);
      r.departure_delay = corrected;
    }
    const schedArr = hmsToSec(r.scheduled_arrival_time);
    if (schedArr != null) {
      r.estimated_arrival_time = secToHms(schedArr + corrected);
      r.arrival_delay = corrected;
    }
  }
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
    if (vpos) {
      enriched.real_time_data = 1;
      enriched.has_gps = 1;
    }
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
  if (appliedRT) enriched.has_rt = 1;
  if (vpos) enriched.has_gps = 1;

  // Expose the minimum stop sequence present in trip updates. Filters use this
  // to detect whether the bus has already passed a given stop: if
  // rt_min_stop_sequence > stop_sequence, all remaining updates are ahead of
  // that stop, meaning the bus has departed.
  if (rt.stopUpdates?.length) {
    const seqs = rt.stopUpdates
      .map(u => Number(u.stopSequence))
      .filter(s => Number.isFinite(s) && s > 0);
    if (seqs.length) enriched.rt_min_stop_sequence = Math.min(...seqs);
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
    // Redis direct hit → freshest cached position
    // In-memory latestVposMap by trip ID → survives Redis TTL expiry between GPS broadcasts
    // Label-based fallback → trains only, when trip ID doesn't match
    const directVpos = t ? (vposMap.get(t) || latestVposMap.get(t)) : null;
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

function effectiveRowSec(row) {
  const t = row?.estimated_departure_time || row?.estimated_arrival_time ||
    row?.scheduled_departure_time || row?.scheduled_arrival_time;
  if (!t) return row?.win_sec ?? null;
  let sec = hmsToSec(t);
  if (sec == null) return row?.win_sec ?? null;
  const winSec = Number(row?.win_sec);
  if (Number.isFinite(winSec) && winSec - sec > 43200) sec += 86400;
  return sec;
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
    return [];
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
    .sort((a, b) => a.sort_rank - b.sort_rank || a.route_short_name.localeCompare(b.route_short_name))
    .map(({ sort_rank, ...rest }) => rest);

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
  if (!searchTerm) {
    return [];
  }

  // Split into tokens so "Adelaide St Stop 40" matches "Adelaide Street Stop 40"
  // Each token is matched against both stop_name and stop_code so searches like "001234" work
  const tokens = searchTerm.trim().split(/\s+/).filter(t => t.length > 0);
  const tokenClauses = tokens.map((_, i) => `(stop_name LIKE $tok${i} OR stop_code LIKE $tok${i})`).join(' AND ');
  const tokenParams = Object.fromEntries(tokens.map((t, i) => [`tok${i}`, `%${t}%`]));

  const sql = `
    SELECT stop_id, stop_code, stop_name, stop_lat, stop_lon, location_type,
      CASE
        WHEN stop_code = $exactCode          THEN 0
        WHEN stop_name LIKE $fullPrefix      THEN 1
        WHEN stop_name LIKE $fullContains    THEN 2
        ELSE                                      3
      END AS sort_rank
    FROM stops
    WHERE ${tokenClauses}
    ORDER BY sort_rank ASC, (location_type != 1) ASC, stop_name ASC
  `;
  const params = {
    ...tokenParams,
    exactCode: searchTerm.trim(),
    fullPrefix: `${searchTerm}%`,
    fullContains: `%${searchTerm}%`,
  };

  const rows = await withDb(db => db.prepare(sql).all(params), configPath);
  return rows.map(({ sort_rank, ...rest }) => rest);
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
    // Pre-filter with a generous bounding box (~5km at Brisbane latitude)
    const degBuffer = 0.05; // ~5.5km
    const rows = db.prepare(`
      SELECT stop_id, stop_name, stop_lat, stop_lon, location_type
      FROM stops
      WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
        AND (location_type IS NULL OR location_type IN (0, 1))
        AND parent_station IS NULL
        AND stop_lat BETWEEN ? AND ?
        AND stop_lon BETWEEN ? AND ?
    `).all(lat - degBuffer, lat + degBuffer, lng - degBuffer, lng + degBuffer);

    let candidates = rows;
    if (candidates.length < limit) {
      candidates = db.prepare(`
        SELECT stop_id, stop_name, stop_lat, stop_lon, location_type
        FROM stops
        WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
          AND (location_type IS NULL OR location_type IN (0, 1))
          AND parent_station IS NULL
      `).all();
    }

    const topN = candidates
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

  // Build canonical stop mapping for diagram positioning
  const canonicalStops = await getStopsByRoute(routeId, direction, configPath);
  const stopIdToCanonicalSeq = new Map();
  const stopIdToCoords = new Map();
  for (const s of canonicalStops) {
    if (s.stop_id != null) {
      stopIdToCanonicalSeq.set(String(s.stop_id), s.stop_sequence);
      if (s.stop_lat != null && s.stop_lon != null) {
        stopIdToCoords.set(String(s.stop_id), { lat: Number(s.stop_lat), lon: Number(s.stop_lon), seq: s.stop_sequence });
      }
    }
  }

  // Find the nearest canonical stop sequence for a given GPS position.
  function _gpsToStopSequence(vLat, vLon) {
    let bestDist = Infinity, bestSeq = null;
    for (const { lat, lon, seq } of stopIdToCoords.values()) {
      const dLat = (vLat - lat) * 111_320;
      const dLon = (vLon - lon) * 111_320 * Math.cos(vLat * Math.PI / 180);
      const d = dLat * dLat + dLon * dLon; // squared meters, fine for comparison
      if (d < bestDist) { bestDist = d; bestSeq = seq; }
    }
    return bestSeq;
  }

  function annotateRows(rows) {
    const epochNow = Math.floor(Date.now() / 1000);
    for (const r of rows) {
      const eSec = effectiveRowSec(r);
      r.minutes_away = (eSec != null) ? Math.max(0, Math.round((eSec - secNow) / 60)) : null;
      r.canonical_stop_sequence = stopIdToCanonicalSeq.get(String(r.stop_id)) ?? r.stop_sequence ?? null;

      // If the TripUpdate predicts the bus is still far away but GPS shows it's
      // already at (or past) this stop, override minutes_away to 0.
      // This corrects stale delay predictions from non-incremental feeds.
      // Skip for trips that haven't started (depot buses near mid-route stops).
      if (r.minutes_away != null && r.minutes_away > 1 &&
          r.vehicle_latitude != null && r.vehicle_longitude != null &&
          r.vehicle_timestamp != null && (epochNow - r.vehicle_timestamp) <= STALE_GPS_SEC) {
        const tripNotStarted = Number(r.stop_sequence) === 1 && r.win_sec > secNow;
        if (!tripNotStarted) {
          const gpsSeq = _gpsToStopSequence(Number(r.vehicle_latitude), Number(r.vehicle_longitude));
          if (gpsSeq != null && gpsSeq >= Number(r.stop_sequence)) {
            r.minutes_away = 0;
          }
        }
      }
    }
  }

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

  // Clear SQL view's precomputed RT fields before re-enriching from Redis,
  // consistent with getUpcomingByStop/getUpcomingByStation. Without this,
  // stale delays baked into the view persist after the Redis TTL expires.
  for (const r of rows) {
    r.estimated_arrival_time = null;
    r.estimated_departure_time = null;
    r.arrival_delay = null;
    r.departure_delay = null;
    r.real_time_data = 0;
  }

  // Enrich with realtime (cache) then re-sort by effective time
  const enriched = await enrichRowsWithRealtime(rows);
  enriched.sort((a, b) =>
    (a.win_sec + (a.arrival_delay || 0)) - (b.win_sec + (b.arrival_delay || 0))
  );
  const tripIds = [...new Set(enriched.map(r => r.trip_id).filter(Boolean))];
  const rtTripLookups = await Promise.all(tripIds.map(id => cacheGet(tripKey(id))));
  const rtTripMap = new Map(tripIds.map((id, i) => [id, rtTripLookups[i]]));

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
  //
  // rtAheadByTrip (rt_seq > seq, no GPS): GTFS-RT stop updates are incremental,
  //   so the first stopUpdate sequence marks the current or next stop even when
  //   there is no vehicle position. Advance to that stop sequence.
  const MAX_OVERDUE_SEC = 480; // 8 minutes
  const staleByTrip = new Map();
  const behindByTrip = new Map();
  const rtAheadByTrip = new Map();
  const epochNow = Math.floor(Date.now() / 1000);
  for (const r of enriched) {
    let vseq = Number(r.vehicle_current_stop_sequence);
    const rowSeq = Number(r.stop_sequence);
    // 0 is the protobuf default (field not set); treat as unknown, not sequence 0.
    // Only trust GPS stop sequence if it is fresh — a stale fix may be many stops
    // behind reality and would mislead the stale/behind correction below.
    const gpsIsFresh = r.vehicle_timestamp != null &&
      (epochNow - r.vehicle_timestamp) <= STALE_GPS_SEC;

    // Some TransLink vehicles always report currentStopSequence=1 regardless
    // of position. Only apply the GPS proximity override in that case — for
    // any valid mid-route vseq (> 1) the feed value is trusted as-is, since
    // replacing it with the nearest canonical stop (pure Euclidean distance)
    // can snap to a wrong stop when two stops are geographically close but
    // separated by several sequence positions.
    if (vseq === 1 && gpsIsFresh &&
        r.vehicle_latitude != null && r.vehicle_longitude != null) {
      // Skip GPS override for trips that haven't started yet — the bus
      // may be at a depot near mid-route stops. Trust vseq=1 when the
      // scheduled departure from stop 1 is still in the future.
      const tripNotStarted = r.win_sec > secNow;
      if (!tripNotStarted) {
        const gpsSeq = _gpsToStopSequence(Number(r.vehicle_latitude), Number(r.vehicle_longitude));
        if (gpsSeq != null) vseq = gpsSeq;
      }
    }

    if (Number.isFinite(vseq) && vseq > 0 && Number.isFinite(rowSeq) && gpsIsFresh) {
      if (vseq > rowSeq) {
        staleByTrip.set(r.trip_id, vseq);
      } else if (vseq < rowSeq) {
        behindByTrip.set(r.trip_id, vseq);
      }
      continue;
    }

    // GPS is absent or stale — use the RT trip update's minimum stop sequence as
    // a position hint instead. GTFS-RT feeds only include stops from the vehicle's
    // current position onwards, so the minimum stopSequence in the update marks
    // the current or next stop. However, some feeds include ALL stops (full
    // schedule), so only trust this if min_seq > 1.
    const rt = rtTripMap.get(r.trip_id);
    const _rtSeqs = Array.isArray(rt?.stopUpdates)
      ? rt.stopUpdates.map(u => Number(u?.stopSequence)).filter(seq => Number.isFinite(seq) && seq > 0)
      : [];
    const rtSeq = _rtSeqs.length > 0 ? Math.min(..._rtSeqs) : null;
    if (rtSeq != null && rtSeq > 1 && Number.isFinite(rowSeq) && rtSeq > rowSeq) {
      rtAheadByTrip.set(r.trip_id, rtSeq);
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

  const needsReplacement = staleByTrip.size > 0 || behindByTrip.size > 0 || rtAheadByTrip.size > 0;
  if (!needsReplacement) {
    let visible = _filterActiveVehicles(enriched, secNow);
    visible = await injectUnplannedRailRows(visible, {
      routeShortName: family.routeShortName,
      direction,
      secNow,
      endSec: secEnd,
      configPath,
    });
    await applyGpsCorrectedDelays(visible, secNow, configPath);
    visible.sort((a, b) =>
      (a.win_sec + (a.arrival_delay || 0)) - (b.win_sec + (b.arrival_delay || 0))
    );
    annotateRows(visible);
    return visible.filter(r => {
      if (r.minutes_away != null && r.minutes_away > MAX_MINUTES_AWAY) return false;
      // Exclude scheduled rows from alternate trip patterns (e.g. short-run trips
      // whose first stop maps to a mid-route canonical position). They appear as
      // confusing mid-route entries in the diagram.
      if (!r.vehicle_label && r.stop_sequence === 1 &&
          r.canonical_stop_sequence != null && r.canonical_stop_sequence > 1) return false;
      return true;
    });
  }

  const replacements = await withDb(db => {
    const out = [];

    for (const [tripId, currentSeq] of staleByTrip) {
      // Use win_sec (not event_sec) to filter by day — stop_events_3day has
      // yesterday/today/tomorrow rows with identical event_sec values. Without
      // this, LIMIT 1 with no ORDER BY can return yesterday's row (win_sec < 0).
      let next = db.prepare(stopSelectSql + `
        WHERE trip_id = $tripId
          AND stop_sequence = $currentSeq
          AND win_sec >= $minWinSec
        ORDER BY win_sec ASC
        LIMIT 1
      `).get({ tripId, currentSeq, minWinSec: secNow - MAX_OVERDUE_SEC });
      if (!next) {
        // If the exact stop has just fallen outside the freshness window,
        // still prefer the GPS-reported sequence over jumping ahead.
        // ABS(win_sec - secNow) picks the row closest to now, ensuring
        // today's row wins over yesterday's or tomorrow's.
        next = db.prepare(stopSelectSql + `
          WHERE trip_id = $tripId
            AND stop_sequence = $currentSeq
          ORDER BY ABS(win_sec - $secNow) ASC
          LIMIT 1
        `).get({ tripId, currentSeq, secNow });
      }
      if (!next) {
        // Final fallback: nearest downstream stop still in the active window.
        next = db.prepare(stopSelectSql + `
        WHERE trip_id = $tripId
          AND stop_sequence >= $currentSeq
          AND win_sec BETWEEN $startSec AND $endSec
        ORDER BY stop_sequence ASC
        LIMIT 1
        `).get({ tripId, currentSeq, startSec: secNow - MAX_LOOKBACK_SEC, endSec: secEnd });
      }
      if (next) out.push(next);
    }

    for (const [tripId, currentSeq] of behindByTrip) {
      // Use win_sec (not event_sec) — same day-bucket fix as staleByTrip above.
      let prev = db.prepare(stopSelectSql + `
        WHERE trip_id = $tripId
          AND stop_sequence = $currentSeq
          AND win_sec >= $minWinSec
        ORDER BY win_sec ASC
        LIMIT 1
      `).get({ tripId, currentSeq, minWinSec: secNow - MAX_OVERDUE_SEC });
      if (!prev) {
        // If the exact stop has become older than MAX_OVERDUE_SEC but GPS still
        // reports the vehicle at this sequence, prefer that sequence anyway.
        // ABS(win_sec - secNow) picks today's row over yesterday's or tomorrow's.
        prev = db.prepare(stopSelectSql + `
          WHERE trip_id = $tripId
            AND stop_sequence = $currentSeq
          ORDER BY ABS(win_sec - $secNow) ASC
          LIMIT 1
        `).get({ tripId, currentSeq, secNow });
      }
      if (!prev) {
        // Final fallback: choose the nearest downstream stop in the window.
        prev = db.prepare(stopSelectSql + `
          WHERE trip_id = $tripId
            AND stop_sequence > $currentSeq
            AND win_sec BETWEEN $startSec AND $endSec
          ORDER BY stop_sequence ASC
          LIMIT 1
        `).get({ tripId, currentSeq, startSec: secNow - MAX_LOOKBACK_SEC, endSec: secEnd });
      }
      if (prev) out.push(prev);
    }

    for (const [tripId, currentSeq] of rtAheadByTrip) {
      const next = db.prepare(stopSelectSql + `
        WHERE trip_id = $tripId
          AND stop_sequence >= $currentSeq
          AND win_sec BETWEEN $startSec AND $endSec
        ORDER BY stop_sequence ASC
        LIMIT 1
      `).get({ tripId, currentSeq, startSec: secNow - MAX_LOOKBACK_SEC, endSec: secEnd });
      if (next) out.push(next);
    }

    return out;
  }, configPath);

  const replacementsEnriched = await enrichRowsWithRealtime(replacements);
  const replacedTrips = new Set([...staleByTrip.keys(), ...behindByTrip.keys(), ...rtAheadByTrip.keys()]);
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
  await applyGpsCorrectedDelays(visible, secNow, configPath);
  visible.sort((a, b) =>
    (a.win_sec + (a.arrival_delay || 0)) - (b.win_sec + (b.arrival_delay || 0))
  );
  annotateRows(visible);
  return visible.filter(r => {
    if (r.minutes_away != null && r.minutes_away > MAX_MINUTES_AWAY) return false;
    if (!r.vehicle_label && r.stop_sequence === 1 &&
        r.canonical_stop_sequence != null && r.canonical_stop_sequence > 1) return false;
    return true;
  });
}

// Keep a row if it's in the normal future window, or if GPS confirms the
// vehicle hasn't yet passed this stop (late-running, no trip-update delay).
// Drops overdue rows with no GPS evidence of being still active.
function _filterActiveVehicles(rows, secNow) {
  const epochNow = Math.floor(Date.now() / 1000);
  return rows.filter(r => {
    if (r.win_sec >= secNow) return true;
    // First line of defense: trip updates show bus is at or beyond a stop
    // sequence that is already past ours — it has departed this stop.
    if (r.rt_min_stop_sequence != null && r.rt_min_stop_sequence > r.stop_sequence) {
      return false;
    }
    // Second safeguard: trust vpos stop sequence only if GPS is fresh.
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

  // Only UNPLANNED vehicles can be injected here — planned vehicles are already
  // surfaced via the normal SQLite/RT path. Passing only these to
  // getVehiclePositionsWithRoutes avoids a 380ms stop_events_3day query with
  // all ~1300 active vehicle trip IDs.
  const unplannedVposMap = new Map();
  for (const [tripId, vpos] of vposMap) {
    if (String(tripId).startsWith('UNPLANNED-')) unplannedVposMap.set(tripId, vpos);
  }
  if (unplannedVposMap.size === 0) return rows;

  const vehicles = await getVehiclePositionsWithRoutes(unplannedVposMap, configPath);
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
      arrival_delay: 0,
      departure_delay: 0,
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
      has_rt: false,
      has_gps: !!(v.lat && v.lon),
      realtime_updated_at: v.timestamp ? v.timestamp * 1000 : null,
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

  // Clear precomputed RT fields from the SQLite view so stale values don't
  // persist after Redis trip updates expire. Fresh RT will be re-applied below.
  for (const r of rows) {
    r.estimated_arrival_time = null;
    r.estimated_departure_time = null;
    r.arrival_delay = null;
    r.departure_delay = null;
    r.real_time_data = 0;
  }

  // Enrich with realtime (cache)
  const enriched = await enrichRowsWithRealtime(rows);

  // For vehicles with bogus currentStopSequence=1, the RT delay is anchored to
  // the wrong position. Recompute estimated times from actual GPS position.
  await applyGpsCorrectedDelays(enriched, startSec, configPath);

  // Keep a row if:
  //   - scheduled in the normal future window (win_sec >= startSec), OR
  //   - in the overdue back-window: GPS confirms the vehicle hasn't yet passed
  //     this stop (late bus still approaching). Rows without GPS data are dropped
  //     from the overdue window to avoid surfacing cancelled/completed services.
  let visible = enriched.filter(r => {
    // First line of defense: trip updates confirm bus is already past this stop.
    if (r.rt_min_stop_sequence != null && r.rt_min_stop_sequence > r.stop_sequence) {
      return false;
    }
    // Second safeguard: trust vpos stop sequence only if GPS is fresh.
    if (r.vehicle_current_stop_sequence != null) {
      const epochNow = Math.floor(Date.now() / 1000);
      const gpsIsFresh = r.vehicle_timestamp != null &&
        (epochNow - r.vehicle_timestamp) <= STALE_GPS_SEC;
      if (gpsIsFresh) return r.vehicle_current_stop_sequence <= r.stop_sequence;
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
  // Compute server-side minutes_away so the client doesn't need to derive it
  // from a Brisbane HH:MM string using browser local time (timezone-unsafe).
  for (const r of visible) {
    const eSec = effectiveRowSec(r);
    r.minutes_away = eSec != null ? Math.max(0, Math.round((eSec - startSec) / 60)) : null;
  }
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
    // First line of defense: trip updates confirm bus is already past this stop.
    if (r.rt_min_stop_sequence != null && r.rt_min_stop_sequence > r.stop_sequence) {
      return false;
    }
    // Second safeguard: trust vpos stop sequence only if GPS is fresh.
    if (r.vehicle_current_stop_sequence != null) {
      const epochNow = Math.floor(Date.now() / 1000);
      const gpsIsFresh = r.vehicle_timestamp != null &&
        (epochNow - r.vehicle_timestamp) <= STALE_GPS_SEC;
      if (gpsIsFresh) return r.vehicle_current_stop_sequence <= r.stop_sequence;
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
  // Compute server-side minutes_away so the client doesn't need to derive it
  // from a Brisbane HH:MM string using browser local time (timezone-unsafe).
  for (const r of visible) {
    const eSec = effectiveRowSec(r);
    r.minutes_away = eSec != null ? Math.max(0, Math.round((eSec - startSec) / 60)) : null;
  }
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

    // Only query stop_events_3day for planned trips — UNPLANNED trips have no
    // static schedule rows, so including them wastes significant time (the IN
    // clause with 1000+ IDs triggers a full view scan).
    const stopEventTripIds = [...new Set([
      ...tripRows.map(row => row.trip_id),
      ...fallbackRows.map(row => row.schedule_trip_id || row.trip_id),
    ])].filter(id => !String(id).startsWith('UNPLANNED-'));
    const stopEventRows = stopEventTripIds.length > 0
      ? (() => {
        const stopEventPlaceholders = stopEventTripIds.map(() => '?').join(',');
        return db.prepare(`
            SELECT
              se.trip_id,
              se.stop_id,
              se.stop_name,
              se.stop_sequence,
              se.win_sec,
              se.arrival_time AS scheduled_arrival_time,
              se.departure_time AS scheduled_departure_time,
              se.estimated_arrival_time,
              se.estimated_departure_time,
              s.stop_lat,
              s.stop_lon
            FROM stop_events_3day se
            LEFT JOIN stops s ON s.stop_id = se.stop_id
            WHERE se.trip_id IN (${stopEventPlaceholders})
          `).all(...stopEventTripIds);
      })()
      : [];

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

  // Haversine distance in meters between two lat/lon pairs.
  // (delegates to module-level haversineM)
  function _haversineM(lat1, lon1, lat2, lon2) {
    return haversineM(lat1, lon1, lat2, lon2);
  }

  // Maximum distance (meters) between vehicle GPS and the reported stop before
  // we distrust the GTFS-RT currentStopSequence and fall back to GPS proximity.
  const MAX_STOP_DISTANCE_M = 2000;

  function pickNextStop(rows, currentStopSequence, vehicleLat, vehicleLon) {
    if (!rows || rows.length === 0) return null;

    const annotated = rows.map(row => ({
      ...row,
      _adjustedSec: adjustedEventSec(row),
    }));

    const hasGps = vehicleLat != null && vehicleLon != null;

    if (currentStopSequence != null && currentStopSequence > 0) {
      const exact = annotated.find(row => Number(row.stop_sequence) === Number(currentStopSequence));

      // Validate the reported stop against GPS: if the vehicle is far from
      // the reported stop, the feed's currentStopSequence is unreliable
      // (TransLink sometimes reports seq=1 for the entire trip).
      if (exact && hasGps && exact.stop_lat != null && exact.stop_lon != null) {
        const dist = _haversineM(vehicleLat, vehicleLon, Number(exact.stop_lat), Number(exact.stop_lon));
        if (dist <= MAX_STOP_DISTANCE_M) return exact;

        // Depot bus protection: if the feed reports seq=1 and the trip's
        // first stop departure is still in the future, the bus is likely
        // waiting at a depot — don't GPS-override to a random mid-route stop.
        if (Number(currentStopSequence) === 1) {
          const firstStop = annotated
            .filter(r => Number(r.stop_sequence) === 1)
            .sort((a, b) => a._adjustedSec - b._adjustedSec)[0];
          if (firstStop && firstStop._adjustedSec > secNow) return exact;
        }

        // Fall through to GPS-based matching below
      } else if (exact && !hasGps) {
        return exact;
      }

      // If GPS didn't invalidate, try nearest downstream by sequence
      if (!hasGps) {
        const bySequence = annotated
          .filter(row => Number(row.stop_sequence) >= Number(currentStopSequence))
          .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
        if (bySequence.length) return bySequence[0];
      }
    }

    // GPS-based proximity: find the nearest stop, then pick the next upcoming
    // stop at or after it so the display shows where the vehicle is heading.
    if (hasGps) {
      const withDist = annotated
        .filter(row => row.stop_lat != null && row.stop_lon != null)
        .map(row => ({
          ...row,
          _dist: _haversineM(vehicleLat, vehicleLon, Number(row.stop_lat), Number(row.stop_lon)),
        }));
      if (withDist.length) {
        withDist.sort((a, b) => a._dist - b._dist);
        const nearestSeq = Number(withDist[0].stop_sequence);
        // Pick the first upcoming stop at or after the nearest (heading forward)
        const upcoming = annotated
          .filter(row => Number(row.stop_sequence) >= nearestSeq)
          .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
        if (upcoming.length) return upcoming[0];
      }
    }

    // Fallback: prefer stops that are still upcoming by time.
    var candidates = annotated.filter(row => row._adjustedSec >= (secNow - 60));
    if (!candidates.length) candidates = annotated;

    candidates.sort((a, b) => a._adjustedSec - b._adjustedSec || a.stop_sequence - b.stop_sequence);
    return candidates[0] || null;
  }

  const stopEventMap = new Map();
  for (const row of stopEventRows) {
    if (!stopEventMap.has(row.trip_id)) stopEventMap.set(row.trip_id, []);
    stopEventMap.get(row.trip_id).push(row);
  }

  const allRows = [...tripRows, ...fallbackRows];
  const startTimestamp = Math.floor(Date.now() / 1000);
  // Max age for GPS: 10 minutes. Beyond this the position is stale.
  const GPS_STALE_SECONDS = 600;

  return allRows.map(row => {
    const vpos = vposMap.get(row.trip_id);
    if (!vpos?.latitude || !vpos?.longitude) return null;

    // Filter stale GPS positions (vehicles that stopped reporting)
    if (vpos.timestamp && (startTimestamp - vpos.timestamp) > GPS_STALE_SECONDS) return null;

    const referenceTripId = row.schedule_trip_id || row.trip_id;
    const nextStop = pickNextStop(
      stopEventMap.get(referenceTripId),
      vpos.currentStopSequence ?? null,
      vpos.latitude,
      vpos.longitude,
    );
    const minutesAway = nextStop
      ? Math.max(0, Math.round((nextStop._adjustedSec - secNow) / 60))
      : null;

    // Filter ghost vehicles: completed trips where the schedule wraps to tomorrow
    if (minutesAway != null && minutesAway > MAX_MINUTES_AWAY) return null;

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

export async function getVehiclesByStop(
  stopId,
  duration = 3600,
  configPath = defaultConfigPath
) {
  const startTime = Math.floor(Date.now() / 1000);

  // Determine if this is a station
  const stop = await getOneStop(stopId, configPath);
  const rows = stop?.location_type === 1
    ? await getUpcomingByStation(stopId, startTime, duration, configPath)
    : await getUpcomingByStop(stopId, startTime, duration, configPath);

  const seen = new Set();
  return rows
    .filter(r => {
      const tid = r.trip_id;
      if (!tid || seen.has(tid)) return false;
      seen.add(tid);
      return r.vehicle_latitude && r.vehicle_longitude;
    })
    .map(r => ({
      trip_id: r.trip_id,
      route_id: r.route_id,
      route_short_name: r.route_short_name || '',
      route_color: r.route_color || '',
      route_text_color: r.route_text_color || '',
      route_type: r.route_type ?? 3,
      trip_headsign: r.trip_headsign || '',
      direction_id: r.direction_id,
      lat: r.vehicle_latitude,
      lon: r.vehicle_longitude,
      label: r.vehicle_label || '',
      eta: r.estimated_departure_time || r.scheduled_departure_time ||
           r.estimated_arrival_time || r.scheduled_arrival_time || '',
    }));
}
