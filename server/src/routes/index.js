import { Router } from 'express';
import stopsRouter from './stops.routes.js';
import routesRouter from './routes.routes.js';
import geocodeRouter from './geocode.routes.js';
import vehiclesRouter from './vehicles.routes.js';

const router = Router();

router.use('/stops', stopsRouter);
router.use('/routes', routesRouter);
router.use('/geocode', geocodeRouter);
router.use('/vehicles', vehiclesRouter);

export default router;
