// src/services/gtfsRealtime.service.js
import { cacheGet, cacheSet } from './cache.service.js';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const RT_VPOS_TTL_SEC  = Number(process.env.GTFS_RT_TTL_SECONDS       || 60);   // vehicle positions
const RT_TRIP_TTL_SEC  = Number(process.env.GTFS_RT_TRIP_TTL_SECONDS  || 300);  // delay / stop-update data

function readConfig() {
  try {
    const cfg = JSON.parse(readFileSync('./config.json', 'utf8'));
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

  const writes = [];
  const now = Date.now();

  let wroteTrip = 0, wroteVpos = 0;
  for (const tripId of tuMap.keys()) {
    const a = tuMap.get(tripId);
    writes.push(cacheSet(tripKey(tripId), { tripId, ...a }, RT_TRIP_TTL_SEC).then(() => { wroteTrip++; }));
  }
  for (const tripId of vpMap.keys()) {
    const b = vpMap.get(tripId);
    writes.push(cacheSet(vposKey(tripId), { tripId, ...b }, RT_VPOS_TTL_SEC).then(() => { wroteVpos++; }));
  }
  writes.push(cacheSet('rt:feed:ts', { ts: now }, RT_VPOS_TTL_SEC));
  await Promise.all(writes);
  console.log(`[gtfsrt] wrote rt:trip:* keys=${wroteTrip} rt:vpos:* keys=${wroteVpos}`);
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
