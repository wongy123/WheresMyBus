import { Router } from 'express';
import { getStop, getStopUpcoming } from '../controllers/stop.controller.js';

const router = Router();

// GET /stop/:stopId?serviceDate=YYYY-MM-DD&rollup=auto|station|stop
router.get('/:stopId', getStop);
router.get('/:stopId/upcoming', getStopUpcoming);

export default router;
