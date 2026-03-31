// src/controllers/stops.controller.js
import {
  getAllStops,
  getNearbyStops,
  getStopsInBounds,
  getOneStop as getOneStopService,
  getUpcomingByStop,
  getUpcomingByStation,
  getRoutesByStop,
  getStopPlatforms as getStopPlatformsService,
  getVehiclesByStop,
} from "../services/gtfsQueries.service.js";
// Note: getUpcomingByStop is called directly for non-station stops (location_type != 1)
// to avoid the redundant getStopPlatforms round-trip inside getUpcomingByStation.
import { paginateResponse } from "../utils/paginate.js";
import { parseIntParam } from "../utils/params.js";

/**
 * GET /api/stops/search?q=...&page=1&limit=20
 */
export async function searchStops(req, res, next) {
  try {
    const searchTerm = (req.query.q ?? "").trim();
    const rows = await getAllStops(searchTerm);

    const body = paginateResponse({
      data: rows,
      req,
      res,
      defaultLimit: 25,
      maxLimit: 100,
    });

    res.json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/nearby?lat=&lng=&limit=
 */
export async function nearbyStops(req, res, next) {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "lat and lng are required" });
    }
    const limit = Math.min(parseInt(req.query.limit || "5", 10), 50);
    const stops = await getNearbyStops(lat, lng, limit);
    res.json({ data: stops });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/bounds?north=&south=&east=&west=&limit=
 */
export async function stopsInBounds(req, res, next) {
  try {
    const north = parseFloat(req.query.north);
    const south = parseFloat(req.query.south);
    const east  = parseFloat(req.query.east);
    const west  = parseFloat(req.query.west);
    if ([north, south, east, west].some(v => !Number.isFinite(v))) {
      return res.status(400).json({ error: "north, south, east, west are required" });
    }
    if (north <= south) {
      return res.status(400).json({ error: "north must be greater than south" });
    }
    if (east <= west) {
      return res.status(400).json({ error: "east must be greater than west" });
    }
    const limit = Math.min(parseInt(req.query.limit || "750", 10), 2000);
    const types = req.query.types
      ? req.query.types.split(',').map(Number).filter(n => [0, 2, 3, 4].includes(n))
      : null;
    const stops = await getStopsInBounds(north, south, east, west, types, limit);
    res.json({ data: stops });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/:stopId
 */
export async function getOneStop(req, res, next) {
  try {
    const stopId = req.params.stopId ?? req.query.stopId;
    if (!stopId) return res.status(400).json({ error: "stopId is required" });

    const stop = await getOneStopService(stopId);
    if (!stop) return res.status(404).json({ error: "Stop not found" });

    res.json(stop);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/:stopId/platforms
 */
export async function getStopPlatforms(req, res, next) {
  try {
    const stopId = req.params.stopId;
    const platforms = await getStopPlatformsService(stopId);
    res.json({ data: platforms });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/:stopId/routes
 */
export async function getStopRoutes(req, res, next) {
  try {
    const stopId = req.params.stopId;
    const routes = await getRoutesByStop(stopId);
    res.json({ data: routes });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/:stopId/timetable?startTime=...&duration=...
 */
export async function getStopTimetable(req, res, next) {
  try {
    const stopId = req.params.stopId ?? req.query.stopId;
    if (!stopId) return res.status(400).json({ error: "stopId is required" });

    // Validate the stop exists and determine whether it is a parent station.
    // This also fixes: non-existent stop IDs returning HTTP 200 with empty data.
    const stop = await getOneStopService(stopId);
    if (!stop) return res.status(404).json({ error: "Stop not found" });

    const startTime = parseIntParam(req.query.startTime);
    const duration = parseIntParam(req.query.duration);
    const routes = req.query.routes
      ? req.query.routes.split(',').map(r => r.trim()).filter(Boolean)
      : null;

    // For parent stations (location_type === 1) use getUpcomingByStation, which
    // aggregates child platform results. For regular stops call getUpcomingByStop
    // directly, skipping the getStopPlatforms round-trip that getUpcomingByStation
    // always performs internally.
    const rows = stop.location_type === 1
      ? await getUpcomingByStation(stopId, startTime, duration)
      : await getUpcomingByStop(stopId, startTime, duration);
    const filtered = routes && routes.length
      ? rows.filter(r => routes.includes(r.route_short_name))
      : rows;

    const body = paginateResponse({
      data: filtered,
      req,
      res,
      defaultLimit: 20,
      maxLimit: 100,
    });

    res.json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/:stopId/vehicles?duration=3600
 */
export async function getStopVehicles(req, res, next) {
  try {
    const stopId = req.params.stopId;
    if (!stopId) return res.status(400).json({ error: 'stopId is required' });
    const duration = parseIntParam(req.query.duration) || 3600;
    const vehicles = await getVehiclesByStop(stopId, duration);
    res.json({ data: vehicles });
  } catch (err) {
    next(err);
  }
}
