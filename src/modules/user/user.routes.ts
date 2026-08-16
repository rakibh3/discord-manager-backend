import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { validateRequest } from '@/middlewares/validateRequest';
import { userController } from '@/modules/user/user.controller';
import { userValidation } from '@/modules/user/user.validation';

const router = express.Router();

// Get admin user profile based on logged in admin
router.get('/me', auth(UserRole.ADMIN), userController.getUserProfile);

// Update admin profile based on logged in admin
router.put(
  '/my-profile',
  auth(UserRole.ADMIN),
  validateRequest(userValidation.updateUserProfileValidationSchema),
  userController.updateUserProfile,
);

export const userRouter: Router = router;
