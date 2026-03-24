import { Router } from 'express';
import stopsRouter from './stops.routes.js';
import routesRouter from './routes.routes.js';
import geocodeRouter from './geocode.routes.js';

const router = Router();

router.use('/stops', stopsRouter);
router.use('/routes', routesRouter);
router.use('/geocode', geocodeRouter);

export default router;
