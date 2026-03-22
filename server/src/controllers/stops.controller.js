// src/controllers/stops.controller.js
import {
  getAllStops,
  getNearbyStops,
  getOneStop as getOneStopService,
  getUpcomingByStop,
  getRoutesByStop,
  getStopPlatforms as getStopPlatformsService,
} from "../services/gtfsQueries.service.js";
import {
  paginateResponse,
  buildPaginationAndLinks,
} from "../utils/paginate.js";

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

    const startTimeQ = req.query.startTime;
    const durationQ = req.query.duration;

    const startTime = Number.isFinite(parseInt(startTimeQ, 10)) ? parseInt(startTimeQ, 10) : undefined;
    const duration = Number.isFinite(parseInt(durationQ, 10)) ? parseInt(durationQ, 10) : undefined;

    const rows = await getUpcomingByStop(stopId, startTime, duration);

    const body = paginateResponse({
      data: rows,
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
