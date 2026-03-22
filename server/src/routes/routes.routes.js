import { Router } from 'express';
import {
  searchRoutes,
  getOneRoute,
  getRouteStops,
  getRouteShape,
  getRouteUpcoming,
  getRouteSchedule,
} from '../controllers/routes.controller.js';

const router = Router();

router.get('/search', searchRoutes);
router.get('/:routeId/upcoming', getRouteUpcoming);
router.get('/:routeId/stops', getRouteStops);
router.get('/:routeId/shape', getRouteShape);
router.get('/:routeId/schedule', getRouteSchedule);
router.get('/:routeId', getOneRoute);

export default router;