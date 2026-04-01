import { Router } from 'express';
import { getAlerts } from '../controllers/alerts.controller.js';

const router = Router();

router.get('/', getAlerts);

export default router;
