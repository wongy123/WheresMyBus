import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock service modules
vi.mock('../../src/services/gtfsRealtime.service.js', () => ({
  getLatestVehiclePositions: vi.fn(),
}));

vi.mock('../../src/services/gtfsQueries.service.js', () => ({
  getVehiclePositionsWithRoutes: vi.fn(),
}));

vi.mock('../../src/services/cache.service.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheMGet: vi.fn().mockResolvedValue([]),
}));

import { getLatestVehiclePositions } from '../../src/services/gtfsRealtime.service.js';
import { getVehiclePositionsWithRoutes } from '../../src/services/gtfsQueries.service.js';
import { cacheGet, cacheSet } from '../../src/services/cache.service.js';
import vehiclesRouter from '../../src/routes/vehicles.routes.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/vehicles', vehiclesRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'server_error' }));
  return app;
}

// Sample vehicle data matching the shape returned by getVehiclePositionsWithRoutes
const VEHICLES = [
  { trip_id: 'TRIP_001', lat: -27.467, lon: 153.028, vehicle_id: 'V001', vehicle_label: 'Bus 1', route_short_name: '66', route_type: 3, route_color: '0079C2' },
  { trip_id: 'TRIP_002', lat: -27.490, lon: 153.040, vehicle_id: 'V002', vehicle_label: 'Bus 2', route_short_name: '130', route_type: 3, route_color: '00A651' },
  { trip_id: 'TRIP_003', lat: -27.550, lon: 153.100, vehicle_id: 'V003', vehicle_label: 'Bus 3', route_short_name: '199', route_type: 3, route_color: 'E2231A' },
];

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// GET /vehicles (cache miss path)
// ---------------------------------------------------------------------------
describe('GET /vehicles', () => {
  it('returns 200 with vehicles on cache miss', async () => {
    const vposMap = new Map([
      ['TRIP_001', { latitude: -27.467, longitude: 153.028, vehicleId: 'V001', vehicleLabel: 'Bus 1' }],
      ['TRIP_002', { latitude: -27.490, longitude: 153.040, vehicleId: 'V002', vehicleLabel: 'Bus 2' }],
    ]);
    getLatestVehiclePositions.mockReturnValue(vposMap);
    getVehiclePositionsWithRoutes.mockResolvedValue(VEHICLES);
    cacheGet.mockResolvedValue(null);

    const res = await request(createApp()).get('/vehicles');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0]).toHaveProperty('trip_id');
    expect(res.body.data[0]).toHaveProperty('lat');
    expect(res.body.data[0]).toHaveProperty('lon');
    // cacheSet is called with the full vehicles array wrapped in { data: ... }
    expect(cacheSet).toHaveBeenCalledWith('api:vehicles', { data: VEHICLES }, 10);
  });

  it('returns 200 with vehicles on cache hit', async () => {
    const cachedData = { data: VEHICLES };
    cacheGet.mockResolvedValue(cachedData);

    const res = await request(createApp()).get('/vehicles');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    // Service should NOT be called on cache hit
    expect(getLatestVehiclePositions).not.toHaveBeenCalled();
    expect(getVehiclePositionsWithRoutes).not.toHaveBeenCalled();
  });

  it('returns empty array when no vehicles available', async () => {
    getLatestVehiclePositions.mockReturnValue(new Map());
    getVehiclePositionsWithRoutes.mockResolvedValue([]);
    cacheGet.mockResolvedValue(null);

    const res = await request(createApp()).get('/vehicles');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /vehicles?lat1=&lon1=&lat2=&lon2= (bounding box filter)
// ---------------------------------------------------------------------------
describe('GET /vehicles with bounding box', () => {
  it('filters vehicles within bounding box', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Bounding box: -27.48 to -27.45 lat, 153.02 to 153.05 lon
    // Only TRIP_001 (-27.467, 153.028) should be inside
    const res = await request(createApp())
      .get('/vehicles?lat1=-27.48&lon1=153.02&lat2=-27.45&lon2=153.05');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].trip_id).toBe('TRIP_001');
  });

  it('returns all vehicles when bbox includes all', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Large bounding box that includes all vehicles
    const res = await request(createApp())
      .get('/vehicles?lat1=-28&lon1=152&lat2=-27&lon2=154');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it('returns empty array when bbox excludes all vehicles', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Bounding box far away from all vehicles
    const res = await request(createApp())
      .get('/vehicles?lat1=0&lon1=0&lat2=1&lon2=1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('handles inverted coordinates (lat1 > lat2)', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Inverted: lat1=-27.45 > lat2=-27.48, lon1=153.05 > lon2=153.02
    // Should still work because controller uses Math.min/max
    const res = await request(createApp())
      .get('/vehicles?lat1=-27.45&lon1=153.05&lat2=-27.48&lon2=153.02');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].trip_id).toBe('TRIP_001');
  });

  it('includes vehicle exactly on bbox boundary', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // TRIP_001 is at lat=-27.467, lon=153.028
    // Set bbox boundaries to exactly match
    const res = await request(createApp())
      .get('/vehicles?lat1=-27.467&lon1=153.028&lat2=-27.467&lon2=153.028');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].trip_id).toBe('TRIP_001');
  });
});

// ---------------------------------------------------------------------------
// GET /vehicles?limit=&clat=&clng= (limit with distance sort)
// ---------------------------------------------------------------------------
describe('GET /vehicles with limit and centre', () => {
  it('returns nearest N vehicles when limit is set', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Centre at -27.467, 153.028 (same as TRIP_001)
    // TRIP_001 is distance 0, TRIP_002 is ~2.6km away, TRIP_003 is ~11km away
    const res = await request(createApp())
      .get('/vehicles?limit=2&clat=-27.467&clng=153.028');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // TRIP_001 should be first (closest)
    expect(res.body.data[0].trip_id).toBe('TRIP_001');
    // TRIP_002 should be second
    expect(res.body.data[1].trip_id).toBe('TRIP_002');
  });

  it('returns all vehicles when limit exceeds count', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    const res = await request(createApp())
      .get('/vehicles?limit=10&clat=-27.467&clng=153.028');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it('returns first N vehicles when no centre provided', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Without clat/clng, should just slice the array
    const res = await request(createApp())
      .get('/vehicles?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].trip_id).toBe('TRIP_001');
    expect(res.body.data[1].trip_id).toBe('TRIP_002');
  });

  it('does not mutate original cached data', async () => {
    const originalData = [...VEHICLES];
    cacheGet.mockResolvedValue({ data: originalData });

    await request(createApp())
      .get('/vehicles?limit=1&clat=-27.467&clng=153.028');

    // Original array should still have 3 items
    expect(originalData).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// GET /vehicles?pin= (pin filtering - requires bbox params)
// Note: pin is an OR condition with bbox - it ADDS the pinned vehicle to bbox results
// ---------------------------------------------------------------------------
describe('GET /vehicles with pin filter', () => {
  it('includes pinned vehicle in addition to bbox results', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Global bbox includes all vehicles, pin adds nothing new
    const res = await request(createApp())
      .get('/vehicles?lat1=-90&lon1=-180&lat2=90&lon2=180&pin=TRIP_002');

    expect(res.status).toBe(200);
    // All 3 vehicles: all are in bbox, TRIP_002 also matches pin (OR condition)
    expect(res.body.data).toHaveLength(3);
  });

  it('pin adds vehicle outside bbox to results', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Bbox only includes TRIP_001, but pin adds TRIP_003
    // TRIP_001: lat=-27.467, lon=153.028 - INSIDE bbox
    // TRIP_002: lat=-27.490, lon=153.040 - OUTSIDE bbox (lat > -27.48)
    // TRIP_003: lat=-27.550, lon=153.100 - OUTSIDE bbox
    const res = await request(createApp())
      .get('/vehicles?lat1=-27.48&lon1=153.02&lat2=-27.45&lon2=153.05&pin=TRIP_003');

    expect(res.status).toBe(200);
    // TRIP_001 (in bbox) + TRIP_003 (pin) = 2 vehicles
    expect(res.body.data).toHaveLength(2);
    const tripIds = res.body.data.map(v => v.trip_id);
    expect(tripIds).toContain('TRIP_001');
    expect(tripIds).toContain('TRIP_003');
  });

  it('returns only bbox results when pin does not match', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Bbox includes TRIP_001, pin doesn't match any vehicle
    const res = await request(createApp())
      .get('/vehicles?lat1=-27.48&lon1=153.02&lat2=-27.45&lon2=153.05&pin=NONEXISTENT');

    expect(res.status).toBe(200);
    // Only TRIP_001 is in bbox
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].trip_id).toBe('TRIP_001');
  });

  it('pin filter is ignored without bbox params', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Without bbox params, pin is ignored - all vehicles returned
    const res = await request(createApp())
      .get('/vehicles?pin=TRIP_002');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Combined filters
// ---------------------------------------------------------------------------
describe('GET /vehicles with combined filters', () => {
  it('applies bbox then limit in order', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Bbox includes TRIP_001 and TRIP_002, limit to 1 nearest to centre
    const res = await request(createApp())
      .get('/vehicles?lat1=-27.55&lon1=153&lat2=-27&lon2=154&limit=1&clat=-27.490&clng=153.040');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // TRIP_002 is closest to the centre point (-27.490, 153.040)
    expect(res.body.data[0].trip_id).toBe('TRIP_002');
  });

  it('bbox with pin adds pinned vehicle to results before limit', async () => {
    cacheGet.mockResolvedValue({ data: VEHICLES });

    // Bbox includes TRIP_001 only, pin adds TRIP_003, limit to 1 nearest to centre
    // After bbox+pin: TRIP_001 and TRIP_003
    // After limit with clat=-27.467, clng=153.028: TRIP_001 is closest
    const res = await request(createApp())
      .get('/vehicles?lat1=-27.48&lon1=153.02&lat2=-27.45&lon2=153.05&pin=TRIP_003&limit=1&clat=-27.467&clng=153.028');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // TRIP_001 is at -27.467, 153.028 (distance 0 from centre)
    // TRIP_003 is at -27.550, 153.100 (distance ~10km from centre)
    // So TRIP_001 should be returned
    expect(res.body.data[0].trip_id).toBe('TRIP_001');
  });
});