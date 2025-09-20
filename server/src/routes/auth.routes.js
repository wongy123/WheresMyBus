// src/routes/auth.routes.js
import { Router } from 'express';
import { register, confirm, login } from '../controllers/auth.controller.js';

const router = Router();

router.post('/register', register);
router.post('/confirm', confirm);
router.post('/login', login);

export default router;
