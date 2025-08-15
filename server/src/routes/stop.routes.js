import { Router } from 'express';
import { getStop } from '../controllers/stop.controller.js';

const router = Router();

// GET /stop/:stopId?serviceDate=YYYY-MM-DD&rollup=auto|station|stop
router.get('/:stopId', getStop);

export default router;
