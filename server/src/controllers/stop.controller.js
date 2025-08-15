import * as stopService from '../services/stop.service.js';
import { _internals as liveUtils } from '../services/live.service.js';

const todayAEST = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }); // YYYY-MM-DD

const toInt = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);

export async function getStop(req, res, next) {
  try {
    const stopId = String(req.params.stopId);
    const serviceDate = req.query.serviceDate ?? todayAEST();
    const rollup = (req.query.rollup ?? 'auto').toLowerCase(); // auto|station|stop

    const result = await stopService.getStopOverview({ stopId, serviceDate, rollup });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getStopUpcoming(req, res, next) {
  try {
    const stopId = String(req.params.stopId);
    const datetime = req.query.datetime || new Date().toISOString();
    const routeId = req.query.routeId || null;
    const rollup = (req.query.rollup === 'station' || req.query.rollup === 'stop') ? req.query.rollup : 'auto';

    const hasLimit = Object.prototype.hasOwnProperty.call(req.query, 'limit');
    const hasDuration = Object.prototype.hasOwnProperty.call(req.query, 'duration');

    // Precedence: limit wins; if only duration is provided we’ll use a generous cap
    const limit = hasLimit
      ? Math.min(1000, Math.max(1, toInt(req.query.limit, 50)))
      : (hasDuration ? 1000 : 50);

    // Allow up to 24h windows; ignored when limit is present
    const duration = hasLimit
      ? null
      : (hasDuration ? Math.min(1440, Math.max(1, toInt(req.query.duration, 0))) : 0);

    const targetDate = liveUtils.ymdFromIsoInAest(datetime);
    const useLive = (targetDate === liveUtils.brisbaneTodayYmd());

    const result = await stopService.getStopUpcoming({
      stopId, datetime, routeId, rollup, limit, duration, useLive
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}