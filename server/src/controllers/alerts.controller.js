import { cacheGet } from '../services/cache.service.js';
import { paginateResponse } from '../utils/paginate.js';

/**
 * GET /api/alerts[?route_id=X][?stop_id=Y][?page=1][?limit=20]
 *
 * Returns active alerts from the GTFS-RT alerts feed.
 * Optionally filter to alerts affecting a specific route or stop.
 */
export async function getAlerts(req, res, next) {
  try {
    const alerts = await cacheGet('rt:alerts') ?? [];

    const routeId = req.query.route_id ?? null;
    const stopId  = req.query.stop_id  ?? null;

    let filtered = alerts;
    if (routeId) filtered = filtered.filter(a => a.routeIds.includes(String(routeId)));
    if (stopId)  filtered = filtered.filter(a => a.stopIds.includes(String(stopId)));

    const body = paginateResponse({ data: filtered, req, res, defaultLimit: 20, maxLimit: 100 });
    res.json(body);
  } catch (err) {
    next(err);
  }
}
