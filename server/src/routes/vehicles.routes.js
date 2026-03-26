import { Router } from 'express';
import { getAllVehicles } from '../controllers/vehicles.controller.js';

const router = Router();

router.get('/', getAllVehicles);

export default router;
