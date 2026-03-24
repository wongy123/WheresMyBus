import { Router } from 'express';
import { geocodeSearch } from '../controllers/geocode.controller.js';

const router = Router();

router.get('/', geocodeSearch);

export default router;
