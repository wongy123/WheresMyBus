import { getLatestVehiclePositions } from '../services/gtfsRealtime.service.js';
import { getVehiclePositionsWithRoutes } from '../services/gtfsQueries.service.js';
import { cacheGet, cacheSet } from '../services/cache.service.js';

const VEHICLES_CACHE_KEY = 'api:vehicles';
const VEHICLES_CACHE_TTL = 10; // seconds — matches RT poll interval

/**
 * GET /api/vehicles
 * Returns all current vehicle positions enriched with route/trip info.
 */
export async function getAllVehicles(req, res, next) {
  try {
    const cached = await cacheGet(VEHICLES_CACHE_KEY);
    if (cached) return res.json(cached);

    const vposMap  = getLatestVehiclePositions();
    const vehicles = await getVehiclePositionsWithRoutes(vposMap);
    const body = { data: vehicles };
    await cacheSet(VEHICLES_CACHE_KEY, body, VEHICLES_CACHE_TTL);
    res.json(body);
  } catch (err) {
    next(err);
  }
}
