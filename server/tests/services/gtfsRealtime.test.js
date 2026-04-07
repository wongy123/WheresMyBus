import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/cache.service.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheMGet: vi.fn(),
}));

import {
  buildTripUpdateMap,
  buildVehiclePosMap,
} from '../../src/services/gtfsRealtime.service.js';

// ---------------------------------------------------------------------------
// Synthetic feed helpers
// ---------------------------------------------------------------------------
function makeTuFeed(entities = []) {
  return { entity: entities };
}

function makeTuEntity(tripId, stopTimeUpdate = []) {
  return {
    id: `e-${tripId}`,
    tripUpdate: {
      trip: { tripId },
      stopTimeUpdate,
    },
  };
}

function makeVpFeed(entities = []) {
  return { entity: entities };
}

function makeVpEntity(tripId, overrides = {}) {
  return {
    id: `v-${tripId}`,
    vehicle: {
      trip: { tripId, routeId: '66', directionId: 0, ...overrides.trip },
      position: { latitude: -27.467, longitude: 153.028, ...overrides.position },
      vehicle: { id: 'V001', label: 'Bus 001', ...overrides.vehicle },
      currentStopSequence: 3,
      timestamp: 1712345670,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// buildTripUpdateMap
// ---------------------------------------------------------------------------
describe('buildTripUpdateMap', () => {
  it('returns an empty Map for an empty feed', () => {
    const map = buildTripUpdateMap(makeTuFeed());
    expect(map.size).toBe(0);
  });

  it('skips entities without a tripUpdate', () => {
    const feed = makeTuFeed([{ id: 'no-tu', vehicle: { trip: { tripId: 'x' } } }]);
    expect(buildTripUpdateMap(feed).size).toBe(0);
  });

  it('skips entities whose tripUpdate has no tripId', () => {
    const feed = makeTuFeed([{ id: 'no-id', tripUpdate: { trip: {} } }]);
    expect(buildTripUpdateMap(feed).size).toBe(0);
  });

  it('maps a single trip update correctly', () => {
    const stopTimeUpdate = [
      {
        stopSequence: 3,
        stopId: '600028',
        arrival:   { delay: 120, time: 1712345678 },
        departure: { delay: 120, time: 1712345738 },
      },
    ];
    const feed = makeTuFeed([makeTuEntity('TRIP_001', stopTimeUpdate)]);
    const map  = buildTripUpdateMap(feed);

    expect(map.size).toBe(1);
    expect(map.has('TRIP_001')).toBe(true);

    const entry = map.get('TRIP_001');
    expect(entry).toHaveProperty('updatedAt');
    expect(typeof entry.updatedAt).toBe('number');
    expect(entry.stopUpdates).toHaveLength(1);

    const su = entry.stopUpdates[0];
    expect(su.stopSequence).toBe(3);
    expect(su.stopId).toBe('600028');
    expect(su.arrivalDelay).toBe(120);
    expect(su.departureDelay).toBe(120);
    expect(su.arrivalTime).toBe(1712345678);
    expect(su.departureTime).toBe(1712345738);
  });

  it('handles stop updates with missing arrival/departure gracefully', () => {
    const stopTimeUpdate = [{ stopSequence: 1, stopId: '111' }];
    const feed = makeTuFeed([makeTuEntity('TRIP_002', stopTimeUpdate)]);
    const map  = buildTripUpdateMap(feed);
    const su   = map.get('TRIP_002').stopUpdates[0];

    expect(su.arrivalDelay).toBeNull();
    expect(su.departureDelay).toBeNull();
    expect(su.arrivalTime).toBeNull();
    expect(su.departureTime).toBeNull();
  });

  it('maps multiple trips', () => {
    const feed = makeTuFeed([
      makeTuEntity('TRIP_A'),
      makeTuEntity('TRIP_B'),
      makeTuEntity('TRIP_C'),
    ]);
    expect(buildTripUpdateMap(feed).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildVehiclePosMap
// ---------------------------------------------------------------------------
describe('buildVehiclePosMap', () => {
  it('returns an empty Map for an empty feed', () => {
    expect(buildVehiclePosMap(makeVpFeed()).size).toBe(0);
  });

  it('skips entities without a vehicle', () => {
    const feed = makeVpFeed([{ id: 'no-vp', tripUpdate: { trip: { tripId: 'x' } } }]);
    expect(buildVehiclePosMap(feed).size).toBe(0);
  });

  it('skips vehicles without a tripId', () => {
    const feed = makeVpFeed([{ id: 'no-id', vehicle: { trip: {} } }]);
    expect(buildVehiclePosMap(feed).size).toBe(0);
  });

  it('maps a single vehicle position correctly', () => {
    const feed = makeVpFeed([makeVpEntity('TRIP_001')]);
    const map  = buildVehiclePosMap(feed);

    expect(map.size).toBe(1);
    expect(map.has('TRIP_001')).toBe(true);

    const entry = map.get('TRIP_001');
    expect(entry.latitude).toBeCloseTo(-27.467);
    expect(entry.longitude).toBeCloseTo(153.028);
    expect(entry.vehicleId).toBe('V001');
    expect(entry.vehicleLabel).toBe('Bus 001');
    expect(entry.currentStopSequence).toBe(3);
    expect(entry.timestamp).toBe(1712345670);
    expect(entry.routeId).toBe('66');
    expect(entry.directionId).toBe(0);
  });

  it('handles vehicles with missing optional fields', () => {
    const feed = makeVpFeed([{
      id: 'v-min',
      vehicle: {
        trip: { tripId: 'TRIP_MIN' },
        // no position, vehicle, currentStopSequence, timestamp
      },
    }]);
    const entry = buildVehiclePosMap(feed).get('TRIP_MIN');

    expect(entry.latitude).toBeNull();
    expect(entry.longitude).toBeNull();
    expect(entry.vehicleId).toBeNull();
    expect(entry.vehicleLabel).toBeNull();
    expect(entry.currentStopSequence).toBeNull();
    expect(entry.timestamp).toBeNull();
    expect(entry.routeId).toBeNull();
    expect(entry.directionId).toBeNull();
  });

  it('maps multiple vehicles', () => {
    const feed = makeVpFeed([
      makeVpEntity('TRIP_X'),
      makeVpEntity('TRIP_Y'),
    ]);
    expect(buildVehiclePosMap(feed).size).toBe(2);
  });
});
