// src/services/live.service.js
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

// --- small utils ---
const AEST_TZ = 'Australia/Brisbane';
const AEST_OFFSET = '+10:00'; // Queensland has no daylight savings

function toAestIso(epochSec) {
  const d = new Date(epochSec * 1000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: AEST_TZ,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(d).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${AEST_OFFSET}`;
}

function parseHmsToSec(hms) {
  const [hh, mm, ss] = String(hms).split(':').map(Number);
  return (hh * 3600) + (mm * 60) + (ss || 0);
}

function plannedEpochFrom(serviceDate, plannedSec) {
  const baseMs = Date.parse(`${serviceDate}T00:00:00${AEST_OFFSET}`);
  const sec = (typeof plannedSec === 'number') ? plannedSec : parseHmsToSec(plannedSec);
  return Math.floor(baseMs / 1000) + sec;
}

function brisbaneTodayYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: AEST_TZ });
}

function ymdFromIsoInAest(iso) {
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: AEST_TZ }).format(d); // YYYY-MM-DD
}

// --- fetch & decode both feeds (per request) ---
export async function decodeFeeds() {
  const tuUrl = process.env.GTFS_RT_TRIP_UPDATES_URL;
  const vpUrl = process.env.GTFS_RT_VEHICLE_POSITIONS_URL;
  const timeoutMs = Number(process.env.GTFS_RT_TIMEOUT_MS || 4000);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const [tuRes, vpRes] = await Promise.all([
      fetch(tuUrl, { signal: ctrl.signal }),
      fetch(vpUrl, { signal: ctrl.signal }),
    ]);

    const [tuBuf, vpBuf] = await Promise.all([tuRes.arrayBuffer(), vpRes.arrayBuffer()]);

    const tuFeed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(tuBuf));
    const vpFeed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(vpBuf));

    const headerTs = Math.max(
      Number(tuFeed?.header?.timestamp || 0),
      Number(vpFeed?.header?.timestamp || 0)
    ) || null;

    const tripUpdatesByTripId = new Map();
    for (const ent of tuFeed.entity || []) {
      const tu = ent.tripUpdate || ent.trip_update; // bindings sometimes camel/snake
      if (!tu?.trip?.tripId && !tu?.trip?.trip_id) continue;
      const tripId = tu.trip.tripId || tu.trip.trip_id;
      tripUpdatesByTripId.set(tripId, {
        tripId,
        scheduleRelationship: tu.trip.scheduleRelationship ?? tu.trip.schedule_relationship ?? null,
        stopTimeUpdates: tu.stopTimeUpdate || tu.stop_time_update || [],
        tripDelay: typeof tu.delay === 'number' ? tu.delay : null,
        timestamp: Number(tu.timestamp || 0) || null,
      });
    }

    const vehiclesByTripId = new Map();
    for (const ent of vpFeed.entity || []) {
      const v = ent.vehicle;
      const tripId = v?.trip?.tripId || v?.trip?.trip_id;
      if (!tripId) continue; // only index when tied to a trip
      vehiclesByTripId.set(tripId, {
        tripId,
        id: v?.vehicle?.id || v?.vehicle?.label || null,
        lat: v?.position?.latitude ?? null,
        lon: v?.position?.longitude ?? null,
        currentStatus: v?.currentStatus ?? v?.current_status ?? null,
        currentStopId: v?.stopId || v?.stop_id || null,
        occupancyStatus: v?.occupancyStatus ?? v?.occupancy_status ?? null,
        occupancyPercentage: typeof v?.occupancyPercentage === 'number' ? v.occupancyPercentage : null,
        timestamp: Number(v?.timestamp || 0) || null,
      });
    }

    return { headerTimestamp: headerTs, tripUpdatesByTripId, vehiclesByTripId };
  } finally {
    clearTimeout(timer);
  }
}

// Route-level merge: adjust the trip's planned start by trip-level delay if present.
export function mergeRouteUpcoming({ scheduleTrips, serviceDate, snapshot, useLive }) {
  const items = [];
  let anyLiveUsed = false;

  for (const t of scheduleTrips) {
    const svcDate = t.service_date || serviceDate;         // prefer per-row date
    const plannedSec   = (typeof t.start_time === 'number') ? t.start_time : parseHmsToSec(t.start_time);
    const plannedEpoch = plannedEpochFrom(svcDate, plannedSec);

    let expectedEpoch = null;
    let status = 'SCHEDULE';
    let delaySec = null;
    let vehicle = null;

    if (useLive && snapshot) {
      const tu = snapshot.tripUpdatesByTripId.get(t.trip_id);
      const rel = tu?.scheduleRelationship;
      if (rel === 3 || rel === 'CANCELED') continue; // drop canceled

      if (tu && typeof tu.tripDelay === 'number') {
        expectedEpoch = plannedEpoch + tu.tripDelay;
        delaySec = tu.tripDelay;
        status = delaySec > 60 ? 'DELAYED' : (delaySec < -60 ? 'EARLY' : 'ON_TIME');
        anyLiveUsed = true;
      }

      const vp = snapshot.vehiclesByTripId.get(t.trip_id);
      if (vp) {
        vehicle = {
          id: vp.id,
          lat: vp.lat, lon: vp.lon,
          currentStatus: vp.currentStatus,
          currentStopId: vp.currentStopId,
          occupancy: vp.occupancyStatus ? { status: vp.occupancyStatus, percentage: vp.occupancyPercentage ?? null } : undefined,
          timestamp: vp.timestamp ? toAestIso(vp.timestamp) : null
        };
      }
    }

    items.push({
      tripId: t.trip_id,
      routeId: t.route_id,
      direction: Number(t.direction_id),
      headsign: t.trip_headsign,
      plannedDeparture: toAestIso(plannedEpoch),
      expectedDeparture: expectedEpoch ? toAestIso(expectedEpoch) : null,
      delaySec,
      status: expectedEpoch ? status : 'NO_DATA',
      vehicle: vehicle || null,
      source: expectedEpoch ? 'live' : 'schedule',
      _sortEpoch: expectedEpoch ?? plannedEpoch
    });
  }

  items.sort((a, b) => (a._sortEpoch - b._sortEpoch) || a.tripId.localeCompare(b.tripId));
  for (const it of items) delete it._sortEpoch;

  return {
    lastUpdated: snapshot?.headerTimestamp ? toAestIso(snapshot.headerTimestamp) : null,
    mode: (useLive && anyLiveUsed) ? 'live' : 'schedule',
    data: items
  };
}


// Expose utils we need in route service/controller
export const _internals = { toAestIso, ymdFromIsoInAest, brisbaneTodayYmd };
