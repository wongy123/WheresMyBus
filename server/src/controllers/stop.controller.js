import * as stopService from '../services/stop.service.js';

const todayAEST = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }); // YYYY-MM-DD

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
