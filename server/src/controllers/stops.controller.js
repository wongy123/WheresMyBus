import {
  getAllStops,
  getOneStop as getOneStopService,
  getUpcomingByStop
} from '../services/gtfsQueries.service.js';
import { paginateResponse } from '../utils/paginate.js';

/**
 * GET /api/stops/search?searchTerm=...&page=1&limit=20
 */
export async function searchStops(req, res, next) {
  try {
    const searchTerm = (req.query.searchTerm ?? '').trim();
    const rows = await getAllStops(searchTerm);

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
 * GET /api/stops/:stopId
 * (also accepts ?stopId=... as a fallback)
 */
export async function getOneStop(req, res, next) {
  try {
    const stopId = req.params.stopId ?? req.query.stopId;
    if (!stopId) {
      return res.status(400).json({ error: 'stopId is required' });
    }

    const stop = await getOneStopService(stopId);
    if (!stop) {
      return res.status(404).json({ error: 'Stop not found' });
    }

    res.json(stop);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/:stopId/timetable?startTime=...&duration=...&page=1&limit=20
 * startTime/duration are optional (epoch seconds). Falls back to service defaults.
 */
export async function getStopTimetable(req, res, next) {
  try {
    const stopId = req.params.stopId ?? req.query.stopId;
    if (!stopId) {
      return res.status(400).json({ error: 'stopId is required' });
    }

    const startTimeQ = req.query.startTime;
    const durationQ  = req.query.duration;

    const startTime = Number.isFinite(parseInt(startTimeQ, 10))
      ? parseInt(startTimeQ, 10)
      : undefined;

    const duration = Number.isFinite(parseInt(durationQ, 10))
      ? parseInt(durationQ, 10)
      : undefined;

    const rows = await getUpcomingByStop(stopId, startTime, duration);

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
