import express, { Router } from 'express';

import { validateRequest } from '@/middlewares/validateRequest';
import { authController } from '@/modules/auth/auth.controller';
import { authValidation } from '@/modules/auth/auth.validation';

const router = express.Router();

router.post(
  '/login',
  validateRequest(authValidation.loginValidationSchema),
  authController.loginUser,
);

router.post('/refresh-token', authController.refreshToken);

router.post('/logout', authController.logout);

export const authRouter: Router = router;
