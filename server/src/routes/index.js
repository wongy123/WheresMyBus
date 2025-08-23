import { Router } from 'express';
import stopsRouter from './stops.routes.js';
import routesRouter from './routes.routes.js';

const router = Router();

router.use('/stops', stopsRouter);
router.use('/routes', routesRouter);

export default router;
