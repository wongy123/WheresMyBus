import {
  getAllRoutes,
  getRouteDirections as getRouteDirectionsService,
  getOneRoute as getOneRouteService,
  getUpcomingByRoute,
  getStopsByRoute,
  getRouteShape as getRouteShapeService,
  getRouteSchedule as getRouteScheduleService,
  getNextServiceDate,
} from '../services/gtfsQueries.service.js';
import { paginateResponse } from '../utils/paginate.js';
import { parseIntParam, parseDirection } from '../utils/params.js';
import { cacheGet, cacheSet } from '../services/cache.service.js';

/**
 * GET /api/routes/search?searchTerm=...&page=1&limit=20
 */
export async function searchRoutes(req, res, next) {
  try {
    const searchTerm = (req.query.q ?? '').trim();
    const rows = await getAllRoutes(searchTerm);

    const body = paginateResponse({
      data: rows,
      req,
      res,
      defaultLimit: 25,
      maxLimit: 100
    });

    res.json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routes/:routeId
 * Accepts either route_id or route_short_name as :routeId
 */
export async function getOneRoute(req, res, next) {
  try {
    const identifier = req.params.routeId ?? req.query.routeId;
    if (!identifier) {
      return res.status(400).json({ error: 'routeId is required' });
    }

    const route = await getOneRouteService(identifier);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }

    // Include next_service_date for routes with no service today (typically infrequent buses).
    const { has_service_today, ...routeData } = route;
    if (!route.is_line && !has_service_today) {
      const nextServiceDate = await getNextServiceDate(route.route_id);
      return res.json({ ...routeData, next_service_date: nextServiceDate });
    }

    res.json(routeData);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routes/:routeId/directions
 */
export async function getRouteDirections(req, res, next) {
  try {
    const routeId = req.params.routeId ?? req.query.routeId;
    if (!routeId) {
      return res.status(400).json({ error: 'routeId is required' });
    }

    const cacheKey = `api:route-directions:${routeId}`;
    const cached = await cacheGet(cacheKey);
    if (cached?.available_directions?.length) return res.json(cached);

    const { available: availableDirections, default: defaultDirection } = await getRouteDirectionsService(routeId);
    const body = {
      available_directions: availableDirections,
      default_direction: defaultDirection ?? 0,
    };

    if (availableDirections.length > 0) await cacheSet(cacheKey, body, 300);
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routes/:routeId/stops?direction=0
 */
export async function getRouteStops(req, res, next) {
  try {
    const routeId = req.params.routeId;
    const direction = parseDirection(req.query.direction);
    const cacheKey = `api:stops:${routeId}:${direction}`;

    const cached = await cacheGet(cacheKey);
    if (cached?.data?.length > 0) return res.json(cached);

    const stops = await getStopsByRoute(routeId, direction);
    const body = { data: stops };
    if (stops.length > 0) await cacheSet(cacheKey, body, 3600);
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routes/:routeId/shape?direction=0
 */
export async function getRouteShape(req, res, next) {
  try {
    const routeId = req.params.routeId;
    const direction = parseDirection(req.query.direction);
    const cacheKey = `api:shape:${routeId}:${direction}`;

    const cached = await cacheGet(cacheKey);
    if (cached?.data?.length > 0) return res.json(cached);

    const points = await getRouteShapeService(routeId, direction);
    const body = { data: points };
    if (points.length > 0) await cacheSet(cacheKey, body, 3600);
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routes/:routeId/schedule?direction=0
 */
export async function getRouteSchedule(req, res, next) {
  try {
    const routeId = req.params.routeId;
    const direction = parseDirection(req.query.direction);
    const page = parseIntParam(req.query.page) || 1;
    const limit = Math.min(Math.max(parseIntParam(req.query.limit) || 50, 1), 200);

    // Accept a date param (YYYYMMDD); default to today if absent or invalid.
    const dateRaw = (req.query.date || '').trim();
    const date = /^\d{8}$/.test(dateRaw) ? dateRaw : null;

    const data = await getRouteScheduleService(routeId, direction, date);

    // Paginate trips while keeping full stops list
    const totalTrips = data.trips.length;
    const start = (page - 1) * limit;
    const paginatedTrips = data.trips.slice(start, start + limit);

    res.json({
      stops: data.stops,
      trips: paginatedTrips,
      pagination: {
        page,
        limit,
        total: totalTrips,
        pageCount: Math.ceil(totalTrips / limit),
        hasNext: start + limit < totalTrips,
        hasPrev: page > 1,
      }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routes/:routeId/upcoming?direction=0&startTime=...&duration=...&page=1&limit=20
 * - direction: 0 or 1 (required if provided; omitting uses the service default of 0)
 * - startTime: epoch seconds (optional)
 * - duration: seconds (optional; default 7200 in service)
 */
export async function getRouteUpcoming(req, res, next) {
  try {
    const routeId = req.params.routeId ?? req.query.routeId;
    if (!routeId) {
      return res.status(400).json({ error: 'routeId is required' });
    }

    // Reject an explicitly-supplied direction that is not 0 or 1 so callers
    // get a clear error instead of silently receiving direction-0 results.
    // Note: parseDirection(val, undefined) cannot be used here because JavaScript
    // replaces an explicit `undefined` argument with the default parameter value (0),
    // so we validate the raw query string directly before calling parseDirection.
    let direction;
    if (req.query.direction !== undefined) {
      const d = Number.parseInt(req.query.direction, 10);
      if (d !== 0 && d !== 1) {
        return res.status(400).json({ error: 'direction must be 0 or 1' });
      }
      direction = d;
    }
    const startTime = parseIntParam(req.query.startTime);
    const duration = parseIntParam(req.query.duration);

    const rows = await getUpcomingByRoute(routeId, direction, startTime, duration);

    const body = paginateResponse({
      data: rows,
      req,
      res,
      defaultLimit: 20,
      maxLimit: 100
    });

    res.json(body);
  } catch (err) {
    next(err);
  }
}
