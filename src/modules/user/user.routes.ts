import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { validateRequest } from '@/middlewares/validateRequest';
import { userController } from '@/modules/user/user.controller';
import { userValidation } from '@/modules/user/user.validation';

const router = express.Router();

// Create user profile
router.post(
  '/register',
  validateRequest(userValidation.createUserValidationSchema),
  userController.createUser,
);

// Get user profile based on logged in user
router.get(
  '/me',
  auth(UserRole.ADMIN, UserRole.INSTRUCTOR, UserRole.STUDENT),
  userController.getUserProfile,
);

// Update user email/username based on logged in user
router.put(
  '/my-profile',
  auth(UserRole.ADMIN, UserRole.INSTRUCTOR, UserRole.STUDENT),
  validateRequest(userValidation.updateUserProfileValidationSchema),
  userController.updateUserProfile,
);

export const userRouter: Router = router;
