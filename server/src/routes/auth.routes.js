// src/routes/auth.routes.js
import { Router } from 'express';
import { register, confirm, login, loginMfa } from '../controllers/auth.controller.js';
import { cognitoLogin, cognitoCallback, cognitoRedeem } from '../controllers/cognito.controller.js';

const router = Router();

router.post('/register', register);
router.post('/confirm', confirm);
router.post('/login', login);
router.post('/login/mfa', loginMfa);

router.get('/cognito/login', cognitoLogin);
router.get('/cognito/callback', cognitoCallback);
router.post('/cognito/redeem', cognitoRedeem);

export default router;
