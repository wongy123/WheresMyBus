import { Router } from 'express';
import { getRoute } from '../controllers/route.controller.js';

const router = Router();

// GET /route/:routeId?serviceDate=YYYY-MM-DD&direction=0|1|inbound|outbound&page=1&limit=25
router.get('/:routeId', getRoute);

export default router;
