import { Router } from 'express';
import { cacheGet } from '../services/cache.service.js';
import { getLatestVehiclePositions, getLatestTripUpdateCount } from '../services/gtfsRealtime.service.js';

const router = Router();

router.get('/stats', async (_req, res) => {
  try {
    const vposMap = getLatestVehiclePositions();
    const now = Date.now();
    const feedTs = await cacheGet('rt:feed:ts');
    const lastUpdate = feedTs ? feedTs.ts : null;
    const secondsAgo = lastUpdate ? Math.round((now - lastUpdate) / 1000) : null;

    res.json({
      liveTrips: getLatestTripUpdateCount(),
      liveVehicles: vposMap.size,
      lastUpdateSecondsAgo: secondsAgo,
      status: secondsAgo !== null && secondsAgo < 60 ? 'live' : 'stale',
    });
  } catch (e) {
    console.error('stats error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;