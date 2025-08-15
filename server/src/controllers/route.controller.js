import * as routeService from '../services/route.service.js';

const toInt = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const normaliseDirection = (dir) => {
  if (dir === undefined) return null; // not provided
  if (dir === 'inbound') return 1;
  if (dir === 'outbound') return 0;
  const n = Number(dir);
  if (n === 0 || n === 1) return n;
  return null;
};

const todayAEST = () => {
  // en-CA gives YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
};

export async function getRoute(req, res, next) {
  try {
    const routeId = String(req.params.routeId);
    const serviceDate = (req.query.serviceDate ?? todayAEST()); // YYYY-MM-DD
    const direction = normaliseDirection(req.query.direction);
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 25)));

    const result = await routeService.getRouteOverview({
      routeId, serviceDate, direction, page, limit,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}
