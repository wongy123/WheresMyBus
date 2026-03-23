import {
  getAllRoutes,
  getOneRoute as getOneRouteService,
  getUpcomingByRoute,
  getStopsByRoute,
  getRouteShape as getRouteShapeService,
  getRouteSchedule as getRouteScheduleService,
} from '../services/gtfsQueries.service.js';
import { paginateResponse } from '../utils/paginate.js';
import { parseIntParam, parseDirection } from '../utils/params.js';

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

    res.json(route);
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

    const stops = await getStopsByRoute(routeId, direction);
    res.json({ data: stops });
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

    const points = await getRouteShapeService(routeId, direction);
    res.json({ data: points });
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

    const data = await getRouteScheduleService(routeId, direction);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/routes/:routeId/upcoming?direction=0&startTime=...&duration=...&page=1&limit=20
 * - direction: 0 or 1 (optional; defaults to 0 if omitted/invalid)
 * - startTime: epoch seconds (optional)
 * - duration: seconds (optional; default 7200 in service)
 */
export async function getRouteUpcoming(req, res, next) {
  try {
    const routeId = req.params.routeId ?? req.query.routeId;
    if (!routeId) {
      return res.status(400).json({ error: 'routeId is required' });
    }

    const direction = parseDirection(req.query.direction, undefined);
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
