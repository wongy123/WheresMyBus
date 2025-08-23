import { Router } from 'express';
import {
  searchStops,
  getOneStop,
  getStopTimetable
} from '../controllers/stops.controller.js';

const router = Router();

router.get('/search', searchStops);
router.get('/:stopId/timetable', getStopTimetable);
router.get('/:stopId', getOneStop);

export default router;