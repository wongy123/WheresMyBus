import {
  getAllRoutes,
  getOneRoute as getOneRouteService,
  getUpcomingByRoute
} from '../services/gtfsQueries.service.js';
import { paginateResponse } from '../utils/paginate.js';

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

    // Parse optional params
    const dirQ = Number.parseInt(req.query.direction, 10);
    const direction = dirQ === 0 || dirQ === 1 ? dirQ : undefined;

    const startTimeQ = Number.parseInt(req.query.startTime, 10);
    const startTime = Number.isFinite(startTimeQ) ? startTimeQ : undefined;

    const durationQ = Number.parseInt(req.query.duration, 10);
    const duration = Number.isFinite(durationQ) ? durationQ : undefined;

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
