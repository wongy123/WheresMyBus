import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/services/gtfsQueries.service.js', () => ({
  getAllRoutes:          vi.fn(),
  getRouteDirections:   vi.fn(),
  getOneRoute:          vi.fn(),
  getUpcomingByRoute:   vi.fn(),
  getStopsByRoute:      vi.fn(),
  getRouteShape:        vi.fn(),
  getRouteSchedule:     vi.fn(),
  getNextServiceDate:   vi.fn(),
}));

vi.mock('../../src/services/cache.service.js', () => ({
  cacheGet:  vi.fn().mockResolvedValue(null),
  cacheSet:  vi.fn().mockResolvedValue(undefined),
  cacheMGet: vi.fn().mockResolvedValue([]),
}));

import {
  getAllRoutes,
  getOneRoute,
  getUpcomingByRoute,
  getRouteDirections,
  getNextServiceDate,
} from '../../src/services/gtfsQueries.service.js';
import { cacheGet } from '../../src/services/cache.service.js';
import routesRouter from '../../src/routes/routes.routes.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/routes', routesRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'server_error' }));
  return app;
}

const ROUTE = {
  route_id: '66-305',
  route_short_name: '66',
  route_long_name: 'City - UQ Lakes',
  route_type: 3,
  route_color: '0079C2',
  route_text_color: 'FFFFFF',
  is_line: false,
  has_service_today: true,
};

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// GET /routes/search
// ---------------------------------------------------------------------------
describe('GET /routes/search', () => {
  it('returns 200 with paginated results', async () => {
    getAllRoutes.mockResolvedValue([ROUTE]);

    const res = await request(createApp()).get('/routes/search?q=66');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].route_short_name).toBe('66');
    expect(res.headers['x-total-count']).toBe('1');
  });

  it('returns 200 with empty data for no matches', async () => {
    getAllRoutes.mockResolvedValue([]);

    const res = await request(createApp()).get('/routes/search?q=ZZZNOMATCH');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /routes/:routeId
// ---------------------------------------------------------------------------
describe('GET /routes/:routeId', () => {
  it('returns 200 for a valid route with service today', async () => {
    getOneRoute.mockResolvedValue(ROUTE);

    const res = await request(createApp()).get('/routes/66');

    expect(res.status).toBe(200);
    expect(res.body.route_short_name).toBe('66');
    // has_service_today is stripped from the response
    expect(res.body).not.toHaveProperty('has_service_today');
  });

  it('returns 404 for an unknown route', async () => {
    getOneRoute.mockResolvedValue(null);

    const res = await request(createApp()).get('/routes/UNKNOWN999');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Route not found');
  });

  it('includes next_service_date for routes with no service today', async () => {
    const noServiceRoute = { ...ROUTE, is_line: false, has_service_today: false };
    getOneRoute.mockResolvedValue(noServiceRoute);
    getNextServiceDate.mockResolvedValue('20240410');

    const res = await request(createApp()).get('/routes/66');

    expect(res.status).toBe(200);
    expect(res.body.next_service_date).toBe('20240410');
  });
});

// ---------------------------------------------------------------------------
// GET /routes/:routeId/upcoming
// ---------------------------------------------------------------------------
describe('GET /routes/:routeId/upcoming', () => {
  it('returns 200 with paginated upcoming services', async () => {
    getUpcomingByRoute.mockResolvedValue([
      { trip_id: 'trip1', route_short_name: '66', departure_time: '09:00:00' },
      { trip_id: 'trip2', route_short_name: '66', departure_time: '09:30:00' },
    ]);

    const res = await request(createApp()).get('/routes/66/upcoming?direction=0');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.headers['x-total-count']).toBe('2');
  });

  it('returns 400 for an invalid direction', async () => {
    const res = await request(createApp()).get('/routes/66/upcoming?direction=5');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('direction must be 0 or 1');
  });
});

// ---------------------------------------------------------------------------
// GET /routes/:routeId/directions (cache miss path)
// ---------------------------------------------------------------------------
describe('GET /routes/:routeId/directions', () => {
  it('returns directions on cache miss', async () => {
    cacheGet.mockResolvedValue(null);
    getRouteDirections.mockResolvedValue({ available: [0, 1], default: 0 });

    const res = await request(createApp()).get('/routes/66/directions');

    expect(res.status).toBe(200);
    expect(res.body.available_directions).toEqual([0, 1]);
    expect(res.body.default_direction).toBe(0);
  });
});
