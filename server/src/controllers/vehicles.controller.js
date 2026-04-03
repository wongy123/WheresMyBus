import { getLatestVehiclePositions } from '../services/gtfsRealtime.service.js';
import { getVehiclePositionsWithRoutes } from '../services/gtfsQueries.service.js';
import { cacheGet, cacheSet } from '../services/cache.service.js';

const VEHICLES_CACHE_KEY = 'api:vehicles';
const VEHICLES_CACHE_TTL = 10; // seconds — matches RT poll interval

/**
 * GET /api/vehicles[?lat1=&lon1=&lat2=&lon2=&limit=&clat=&clng=]
 *
 * Optional query params:
 *   lat1, lon1, lat2, lon2 — bounding box (SW and NE corners); only vehicles
 *                             within this box are returned.
 *   limit                  — max vehicles to return; when combined with clat/clng
 *                             the nearest vehicles to the centre are kept.
 *   clat, clng             — map centre (used for distance sort when limit applies).
 *
 * The full vehicle set is computed once per 10s and cached; bbox/limit filtering
 * is applied per-request from the cache so the DB query is not repeated.
 */
export async function getAllVehicles(req, res, next) {
  try {
    let cached = await cacheGet(VEHICLES_CACHE_KEY);
    if (!cached) {
      const vposMap  = getLatestVehiclePositions();
      const vehicles = await getVehiclePositionsWithRoutes(vposMap);
      cached = { data: vehicles };
      await cacheSet(VEHICLES_CACHE_KEY, cached, VEHICLES_CACHE_TTL);
    }

    let vehicles = cached.data;

    // Bounding box filter
    const lat1 = parseFloat(req.query.lat1);
    const lon1 = parseFloat(req.query.lon1);
    const lat2 = parseFloat(req.query.lat2);
    const lon2 = parseFloat(req.query.lon2);
    if (Number.isFinite(lat1) && Number.isFinite(lon1) &&
        Number.isFinite(lat2) && Number.isFinite(lon2)) {
      const minLat = Math.min(lat1, lat2);
      const maxLat = Math.max(lat1, lat2);
      const minLon = Math.min(lon1, lon2);
      const maxLon = Math.max(lon1, lon2);
      const pin = req.query.pin;
      vehicles = vehicles.filter(v =>
        v.trip_id === pin ||
        (v.lat >= minLat && v.lat <= maxLat && v.lon >= minLon && v.lon <= maxLon)
      );
    }

    // Limit: sort by distance to map centre, keep nearest N
    const limit = parseInt(req.query.limit, 10);
    if (Number.isFinite(limit) && limit > 0 && vehicles.length > limit) {
      const clat = parseFloat(req.query.clat);
      const clng = parseFloat(req.query.clng);
      if (Number.isFinite(clat) && Number.isFinite(clng)) {
        vehicles = vehicles
          .map(v => ({ ...v, _d: (v.lat - clat) ** 2 + (v.lon - clng) ** 2 }))
          .sort((a, b) => a._d - b._d)
          .slice(0, limit)
          .map(({ _d, ...v }) => v);
      } else {
        vehicles = vehicles.slice(0, limit);
      }
    }

    res.json({ data: vehicles });
  } catch (err) {
    next(err);
  }
}
