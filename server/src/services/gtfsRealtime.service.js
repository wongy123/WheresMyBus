// src/services/gtfsRealtime.service.js
import { cache } from '../lib/cache.js';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import crypto from 'node:crypto';


// Expect these in config.json or env:
const REGION = process.env.AWS_REGION || 'ap-southeast-2';

// You already have a config.json in your repo; we’ll accept either source:
function readConfig() {
  try {
    // eslint-disable-next-line import/no-commonjs, no-undef
    const cfg = JSON.parse(require('fs').readFileSync('./config.json', 'utf8'));
    return {
      tripUpdatesUrl: process.env.GTFS_RT_TRIP_UPDATES_URL || cfg.tripUpdatesUrl,
      vehiclePositionsUrl: process.env.GTFS_RT_VEHICLE_POSITIONS_URL || cfg.vehiclePositionsUrl,
      pollSeconds: Number(process.env.GTFS_RT_POLL_SECONDS || cfg.pollSeconds || 10),
    };
  } catch {
    return {
      tripUpdatesUrl: process.env.GTFS_RT_TRIP_UPDATES_URL,
      vehiclePositionsUrl: process.env.GTFS_RT_VEHICLE_POSITIONS_URL,
      pollSeconds: Number(process.env.GTFS_RT_POLL_SECONDS || 10),
    };
  }
}

async function fetchProto(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`gtfsrt_fetch_failed ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
}

function buildTripUpdateMap(feed) {
  // tripId -> { updatedAt, stopUpdates: [{ stopSequence, stopId, arrivalTime?, departureTime?, arrivalDelay?, departureDelay? }] }
  const map = new Map();
  const now = Date.now();

  for (const e of feed.entity || []) {
    const tu = e.tripUpdate;
    if (!tu || !tu.trip || !tu.trip.tripId) continue;
    const tripId = String(tu.trip.tripId);

    const stopUpdates = [];
    for (const u of tu.stopTimeUpdate || []) {
      stopUpdates.push({
        stopSequence: u.stopSequence ?? null,
        stopId: u.stopId ? String(u.stopId) : null,
        arrivalTime: u.arrival?.time != null ? Number(u.arrival.time) : null,
        departureTime: u.departure?.time != null ? Number(u.departure.time) : null,
        arrivalDelay: u.arrival?.delay != null ? Number(u.arrival.delay) : null,
        departureDelay: u.departure?.delay != null ? Number(u.departure.delay) : null,
      });
    }
    map.set(tripId, { updatedAt: now, stopUpdates });
  }
  return map;
}

function buildVehiclePosMap(feed) {
  // tripId -> { latitude, longitude, vehicleId, vehicleLabel, currentStopSequence, timestamp }
  const map = new Map();
  for (const e of feed.entity || []) {
    const vp = e.vehicle;
    if (!vp || !vp.trip || !vp.trip.tripId) continue;
    const tripId = String(vp.trip.tripId);
    map.set(tripId, {
      latitude: vp.position?.latitude ?? null,
      longitude: vp.position?.longitude ?? null,
      vehicleId: vp.vehicle?.id ? String(vp.vehicle.id) : null,
      vehicleLabel: vp.vehicle?.label ? String(vp.vehicle.label) : null,
      currentStopSequence: vp.currentStopSequence ?? null,
      timestamp: vp.timestamp != null ? Number(vp.timestamp) : null,
    });
  }
  return map;
}

async function populateCacheOnce({ tripUpdatesUrl, vehiclePositionsUrl }) {
  let tuFeed = null;
  let vpFeed = null;

  // Fetch in parallel (best effort)
  await Promise.allSettled([
    (async () => { if (tripUpdatesUrl) tuFeed = await fetchProto(tripUpdatesUrl); })(),
    (async () => { if (vehiclePositionsUrl) vpFeed = await fetchProto(vehiclePositionsUrl); })(),
  ]);

  const tuMap = tuFeed ? buildTripUpdateMap(tuFeed) : new Map();
  const vpMap = vpFeed ? buildVehiclePosMap(vpFeed) : new Map();

  console.log(`[gtfsrt] tripUpdates=${tuMap.size} vehiclePositions=${vpMap.size}`);

  if (tuMap.size === 0 && vpMap.size === 0) {
    console.warn('[gtfsrt] both feeds empty or failed – check URLs/permissions');
  }

  // Merge by tripId
  const keys = new Set([...tuMap.keys(), ...vpMap.keys()]);
  const writes = [];
  const now = Date.now();

  let wrote = 0;
  for (const tripId of keys) {
    const a = tuMap.get(tripId) || { updatedAt: now, stopUpdates: [] };
    const b = vpMap.get(tripId) || {};
    const merged = { tripId, ...a, vehicle: b };
    writes.push(cache.set(tripKey(tripId), merged, cache.ttl).then(ok => { if (ok) wrote++; }));
  }
  writes.push(cache.set('rt:feed:ts', { ts: now }, cache.ttl));
  await Promise.all(writes);
  console.log(`[gtfsrt] wrote rt:trip:* keys=${wrote}`);
}

function tripKey(tripId) {
  const raw = String(tripId);
  // Encode to remove spaces/newlines; keep result short enough for memcached
  let enc = encodeURIComponent(raw);
  if (enc.length > 240) {
    const h = crypto.createHash('sha1').update(raw).digest('hex');
    enc = `h${h}`; // 41 chars
  }
  return `rt:trip:${enc}`;
}


let timer = null;

export function startGtfsRealtimeLoop() {
  const cfg = readConfig();
  console.log('[gtfsrt] config URLs:', cfg.tripUpdatesUrl, cfg.vehiclePositionsUrl);
  if (!cfg.tripUpdatesUrl && !cfg.vehiclePositionsUrl) {
    console.warn('[gtfsrt] no URLs configured; realtime loop disabled');
    return;
  }
  const pollMs = Math.max(1000, (cfg.pollSeconds || 10) * 1000);

  const tick = async () => {
    try {
      await populateCacheOnce(cfg);
    } catch (e) {
      console.error('[gtfsrt] populate failed:', e?.message || e);
    } finally {
      timer = setTimeout(tick, pollMs);
    }
  };

  console.log('[gtfsrt] starting realtime loop every', pollMs, 'ms');
  tick();
}

export function stopGtfsRealtimeLoop() {
  if (timer) clearTimeout(timer);
  timer = null;
}
