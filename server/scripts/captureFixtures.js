#!/usr/bin/env node
// One-time fixture capture script. Requires the server and GTFS-RT URLs to be available.
// Usage: node server/scripts/captureFixtures.js [api_base_url]
//   api_base_url defaults to http://localhost:3000/api
//
// Set GTFS_RT_TRIP_UPDATES_URL and GTFS_RT_VEHICLE_POSITIONS_URL in server/.env
// before running, or they will be skipped.
//
// Output: tests/fixtures/*.json  (committed to repo as permanent test fixtures)

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const FIXTURES_DIR = path.join(__dirname, '../tests/fixtures');
const SERVER_URL   = (process.argv[2] || 'http://localhost:3000/api').replace(/\/$/, '');
const TU_URL       = process.env.GTFS_RT_TRIP_UPDATES_URL;
const VP_URL       = process.env.GTFS_RT_VEHICLE_POSITIONS_URL;

function mapToObj(map) {
  const obj = {};
  for (const [k, v] of map) obj[k] = v;
  return obj;
}

async function fetchProto(url) {
  console.log(`  fetch proto: ${url}`);
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(await res.arrayBuffer())
  );
}

async function fetchApi(path, params = {}) {
  const url = new URL(`${SERVER_URL}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  console.log(`  fetch api:   ${url}`);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) { console.warn(`  → HTTP ${res.status}`); return null; }
  return res.json();
}

function save(name, data) {
  const file = path.join(FIXTURES_DIR, name);
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`  saved: ${name}`);
}

async function main() {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const failures = [];

  // ---- GTFS-RT: TripUpdates ----
  if (TU_URL) {
    console.log('\n[trip-updates]');
    try {
      const feed = await fetchProto(TU_URL);
      const now  = Date.now();
      const map  = new Map();
      for (const e of feed.entity || []) {
        const tu = e.tripUpdate;
        if (!tu?.trip?.tripId) continue;
        const tripId = String(tu.trip.tripId);
        const stopUpdates = (tu.stopTimeUpdate || []).map(u => ({
          stopSequence:    u.stopSequence ?? null,
          stopId:          u.stopId ? String(u.stopId) : null,
          arrivalTime:     u.arrival?.time    != null ? Number(u.arrival.time)      : null,
          departureTime:   u.departure?.time  != null ? Number(u.departure.time)    : null,
          arrivalDelay:    u.arrival?.delay   != null ? Number(u.arrival.delay)     : null,
          departureDelay:  u.departure?.delay != null ? Number(u.departure.delay)   : null,
        }));
        map.set(tripId, { updatedAt: now, stopUpdates });
      }
      save('rt-trip-updates.json', mapToObj(map));
      console.log(`  → ${map.size} trips`);
    } catch (e) {
      console.error('  FAILED:', e.message);
      failures.push('rt-trip-updates');
    }
  } else {
    console.log('\n[trip-updates] SKIPPED — GTFS_RT_TRIP_UPDATES_URL not set');
  }

  // ---- GTFS-RT: VehiclePositions ----
  if (VP_URL) {
    console.log('\n[vehicle-positions]');
    try {
      const feed = await fetchProto(VP_URL);
      const map  = new Map();
      for (const e of feed.entity || []) {
        const vp = e.vehicle;
        if (!vp?.trip?.tripId) continue;
        const tripId = String(vp.trip.tripId);
        map.set(tripId, {
          latitude:             vp.position?.latitude    ?? null,
          longitude:            vp.position?.longitude   ?? null,
          vehicleId:            vp.vehicle?.id    ? String(vp.vehicle.id)    : null,
          vehicleLabel:         vp.vehicle?.label ? String(vp.vehicle.label) : null,
          currentStopSequence:  vp.currentStopSequence ?? null,
          timestamp:            vp.timestamp != null ? Number(vp.timestamp) : null,
          routeId:              vp.trip?.routeId    ? String(vp.trip.routeId)    : null,
          directionId:          vp.trip?.directionId ?? null,
        });
      }
      save('rt-vehicle-positions.json', mapToObj(map));
      console.log(`  → ${map.size} vehicles`);
    } catch (e) {
      console.error('  FAILED:', e.message);
      failures.push('rt-vehicle-positions');
    }
  } else {
    console.log('\n[vehicle-positions] SKIPPED — GTFS_RT_VEHICLE_POSITIONS_URL not set');
  }

  // ---- API: stop search ----
  console.log('\n[api-stop-search]');
  const stopSearch = await fetchApi('stops/search', { q: 'Roma', limit: 5 });
  if (stopSearch) {
    save('api-stop-search.json', stopSearch);
    console.log(`  → ${stopSearch.data?.length ?? 0} results`);
  } else {
    failures.push('api-stop-search');
  }

  // ---- API: route search ----
  console.log('\n[api-route-search]');
  const routeSearch = await fetchApi('routes/search', { q: '66', limit: 5 });
  if (routeSearch) {
    save('api-route-search.json', routeSearch);
    console.log(`  → ${routeSearch.data?.length ?? 0} results`);
  } else {
    failures.push('api-route-search');
  }

  // ---- API: stop timetable (first result from stop search) ----
  const stopId = stopSearch?.data?.[0]?.stop_id;
  console.log(`\n[api-stop-timetable] stop_id=${stopId ?? 'none'}`);
  if (stopId) {
    const timetable = await fetchApi(`stops/${stopId}/timetable`, { limit: 10 });
    if (timetable) {
      save('api-stop-timetable.json', timetable);
      console.log(`  → ${timetable.data?.length ?? 0} entries`);
    } else {
      failures.push('api-stop-timetable');
    }
  } else {
    console.warn('  SKIPPED — no stop found from search');
    failures.push('api-stop-timetable');
  }

  // ---- API: route upcoming (first result from route search) ----
  const routeId = routeSearch?.data?.[0]?.route_id;
  console.log(`\n[api-route-upcoming] route_id=${routeId ?? 'none'}`);
  if (routeId) {
    const upcoming = await fetchApi(`routes/${routeId}/upcoming`, { direction: 0, limit: 10 });
    if (upcoming) {
      save('api-route-upcoming.json', upcoming);
      console.log(`  → ${upcoming.data?.length ?? 0} entries`);
    } else {
      failures.push('api-route-upcoming');
    }
  } else {
    console.warn('  SKIPPED — no route found from search');
    failures.push('api-route-upcoming');
  }

  // ---- Summary ----
  console.log('\n=== Capture Summary ===');
  console.log(`Stop ID used : ${stopId  ?? 'none'}`);
  console.log(`Route ID used: ${routeId ?? 'none'}`);
  console.log(`Fixtures dir : ${FIXTURES_DIR}`);
  if (failures.length) {
    console.warn(`Failed       : ${failures.join(', ')}`);
    process.exit(1);
  } else {
    console.log('All fixtures captured successfully.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
