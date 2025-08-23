import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { me, updateMe, deleteMe } from '../controllers/users.controller.js';

const router = Router();

router.get('/me',    requireAuth, me);
router.put('/me',    requireAuth, updateMe);
router.delete('/me', requireAuth, deleteMe);

export default router;
