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
  getRoutesByStop,
  getStopPlatforms,
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
});
