import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock service modules with explicit factories so the real modules (and their
// heavy dependencies: gtfs npm package, ioredis, SQLite) are never loaded.
vi.mock('../../src/services/gtfsQueries.service.js', () => ({
  getAllStops:         vi.fn(),
  getNearbyStops:     vi.fn(),
  getStopsInBounds:   vi.fn(),
  getOneStop:         vi.fn(),
  getUpcomingByStop:  vi.fn(),
  getUpcomingByStation: vi.fn(),
  getRoutesByStop:    vi.fn(),
  getStopPlatforms:   vi.fn(),
  getVehiclesByStop:  vi.fn(),
}));

vi.mock('../../src/services/cache.service.js', () => ({
  cacheGet:  vi.fn().mockResolvedValue(null),
  cacheSet:  vi.fn().mockResolvedValue(undefined),
  cacheMGet: vi.fn().mockResolvedValue([]),
}));

import {
  getAllStops,
  getOneStop,
  getUpcomingByStop,
  getUpcomingByStation,
  getRoutesByStop,
  getStopPlatforms,
  getNearbyStops,
} from '../../src/services/gtfsQueries.service.js';
import stopsRouter from '../../src/routes/stops.routes.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/stops', stopsRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'server_error' }));
  return app;
}

const STOP = {
  stop_id: '600028',
  stop_name: 'Roma St Station',
  stop_lat: -27.465,
  stop_lon: 153.028,
  location_type: 0,
  parent_station: null,
};

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// GET /stops/search
// ---------------------------------------------------------------------------
describe('GET /stops/search', () => {
  it('returns 200 with paginated data and X-Total-Count header', async () => {
    getAllStops.mockResolvedValue([STOP]);

    const res = await request(createApp()).get('/stops/search?q=Roma');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].stop_name).toBe('Roma St Station');
    expect(res.headers['x-total-count']).toBe('1');
  });

  it('returns 200 with empty data for no matches', async () => {
    getAllStops.mockResolvedValue([]);

    const res = await request(createApp()).get('/stops/search?q=zzznomatch');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it('calls getAllStops with the q parameter', async () => {
    getAllStops.mockResolvedValue([]);

    await request(createApp()).get('/stops/search?q=Central');

    expect(getAllStops).toHaveBeenCalledWith('Central');
  });
});

// ---------------------------------------------------------------------------
// GET /stops/:stopId
// ---------------------------------------------------------------------------
describe('GET /stops/:stopId', () => {
  it('returns 200 with stop data for a valid stop', async () => {
    getOneStop.mockResolvedValue(STOP);

    const res = await request(createApp()).get('/stops/600028');

    expect(res.status).toBe(200);
    expect(res.body.stop_id).toBe('600028');
    expect(res.body.stop_name).toBe('Roma St Station');
  });

  it('returns 404 for an unknown stop', async () => {
    getOneStop.mockResolvedValue(null);

    const res = await request(createApp()).get('/stops/UNKNOWN999');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Stop not found');
  });
});

// ---------------------------------------------------------------------------
// GET /stops/:stopId/timetable
// ---------------------------------------------------------------------------
describe('GET /stops/:stopId/timetable', () => {
  it('returns 200 with timetable rows for a regular stop', async () => {
    getOneStop.mockResolvedValue(STOP);
    getUpcomingByStop.mockResolvedValue([
      { trip_id: 'trip1', route_short_name: '130', departure_time: '08:00:00' },
      { trip_id: 'trip2', route_short_name: '66',  departure_time: '08:05:00' },
    ]);

    const res = await request(createApp()).get('/stops/600028/timetable');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('returns 404 when the stop does not exist', async () => {
    getOneStop.mockResolvedValue(null);

    const res = await request(createApp()).get('/stops/UNKNOWN/timetable');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Stop not found');
  });

  it('filters rows by routes query param', async () => {
    getOneStop.mockResolvedValue(STOP);
    getUpcomingByStop.mockResolvedValue([
      { trip_id: 'trip1', route_short_name: '130', departure_time: '08:00:00' },
      { trip_id: 'trip2', route_short_name: '66',  departure_time: '08:05:00' },
    ]);

    const res = await request(createApp()).get('/stops/600028/timetable?routes=66');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].route_short_name).toBe('66');
  });
});

// ---------------------------------------------------------------------------
// GET /stops/:stopId/routes
// ---------------------------------------------------------------------------
describe('GET /stops/:stopId/routes', () => {
  it('returns 200 with routes array', async () => {
    getRoutesByStop.mockResolvedValue([
      { route_id: '66', route_short_name: '66', route_type: 3 },
    ]);

    const res = await request(createApp()).get('/stops/600028/routes');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].route_short_name).toBe('66');
  });
});

// ---------------------------------------------------------------------------
// GET /stops/nearby (validation)
// ---------------------------------------------------------------------------
describe('GET /stops/nearby', () => {
  it('returns 400 when lat/lng are missing', async () => {
    const res = await request(createApp()).get('/stops/nearby');

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 200 with nearby stops when lat/lng provided', async () => {
    const nearbyStops = [
      { stop_id: '600001', stop_name: 'Stop A', stop_lat: -27.466, stop_lon: 153.029, distance_m: 150 },
      { stop_id: '600002', stop_name: 'Stop B', stop_lat: -27.468, stop_lon: 153.030, distance_m: 300 },
    ];
    getNearbyStops.mockResolvedValue(nearbyStops);

    const res = await request(createApp()).get('/stops/nearby?lat=-27.467&lng=153.028');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].stop_name).toBe('Stop A');
    expect(getNearbyStops).toHaveBeenCalledWith(-27.467, 153.028, 5);
  });

  it('respects limit parameter', async () => {
    getNearbyStops.mockResolvedValue([]);

    await request(createApp()).get('/stops/nearby?lat=-27.467&lng=153.028&limit=10');

    expect(getNearbyStops).toHaveBeenCalledWith(-27.467, 153.028, 10);
  });

  it('clamps limit to 50', async () => {
    getNearbyStops.mockResolvedValue([]);

    await request(createApp()).get('/stops/nearby?lat=-27.467&lng=153.028&limit=100');

    expect(getNearbyStops).toHaveBeenCalledWith(-27.467, 153.028, 50);
  });
});

// ---------------------------------------------------------------------------
// GET /stops/:stopId/platforms
// ---------------------------------------------------------------------------
describe('GET /stops/:stopId/platforms', () => {
  it('returns 200 with platforms for a station', async () => {
    const platforms = [
      { stop_id: '600028_1', stop_name: 'Roma St Station Platform 1', location_type: 0, parent_station: '600028' },
      { stop_id: '600028_2', stop_name: 'Roma St Station Platform 2', location_type: 0, parent_station: '600028' },
    ];
    getStopPlatforms.mockResolvedValue(platforms);

    const res = await request(createApp()).get('/stops/600028/platforms');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].parent_station).toBe('600028');
  });

  it('returns empty array for a regular stop with no platforms', async () => {
    getStopPlatforms.mockResolvedValue([]);

    const res = await request(createApp()).get('/stops/600001/platforms');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /stops/:stopId/timetable (station branch)
// ---------------------------------------------------------------------------
describe('GET /stops/:stopId/timetable for station', () => {
  const STATION = {
    stop_id: '600028',
    stop_name: 'Roma St Station',
    stop_lat: -27.465,
    stop_lon: 153.028,
    location_type: 1, // Station (parent)
    parent_station: null,
  };

  it('calls getUpcomingByStation for a station (location_type=1)', async () => {
    getOneStop.mockResolvedValue(STATION);
    getUpcomingByStation.mockResolvedValue([
      { trip_id: 'trip1', route_short_name: '66', departure_time: '08:00:00', platform: '1' },
      { trip_id: 'trip2', route_short_name: '130', departure_time: '08:05:00', platform: '2' },
    ]);

    const res = await request(createApp()).get('/stops/600028/timetable');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(getUpcomingByStation).toHaveBeenCalledWith('600028', undefined, undefined);
    expect(getUpcomingByStop).not.toHaveBeenCalled();
  });

  it('calls getUpcomingByStop for a regular stop (location_type=0)', async () => {
    const REGULAR_STOP = { ...STOP, location_type: 0 };
    getOneStop.mockResolvedValue(REGULAR_STOP);
    getUpcomingByStop.mockResolvedValue([
      { trip_id: 'trip1', route_short_name: '66', departure_time: '08:00:00' },
    ]);

    const res = await request(createApp()).get('/stops/600028/timetable');

    expect(res.status).toBe(200);
    expect(getUpcomingByStop).toHaveBeenCalledWith('600028', undefined, undefined);
    expect(getUpcomingByStation).not.toHaveBeenCalled();
  });

  it('passes startTime and duration parameters to station query', async () => {
    getOneStop.mockResolvedValue(STATION);
    getUpcomingByStation.mockResolvedValue([]);

    await request(createApp()).get('/stops/600028/timetable?startTime=3600&duration=7200');

    expect(getUpcomingByStation).toHaveBeenCalledWith('600028', 3600, 7200);
  });
});
