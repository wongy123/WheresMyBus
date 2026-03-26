import { getLatestVehiclePositions } from '../services/gtfsRealtime.service.js';
import { getVehiclePositionsWithRoutes } from '../services/gtfsQueries.service.js';

/**
 * GET /api/vehicles
 * Returns all current vehicle positions enriched with route/trip info.
 */
export async function getAllVehicles(req, res, next) {
  try {
    const vposMap  = getLatestVehiclePositions();
    const vehicles = await getVehiclePositionsWithRoutes(vposMap);
    res.json({ data: vehicles });
  } catch (err) {
    next(err);
  }
}
