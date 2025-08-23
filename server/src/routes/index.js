import { Router } from 'express';
import stopsRouter from './stops.routes.js';
import routesRouter from './routes.routes.js';
import usersRouter from './users.routes.js';
import authRouter from './auth.routes.js';

const router = Router();

router.use('/stops', stopsRouter);
router.use('/routes', routesRouter);
router.use('/users', usersRouter);
router.use('/auth', authRouter);

export default router;
