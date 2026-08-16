import express, { Router } from 'express';

import {
  submitAttendanceRateLimiter,
  verifyUserRateLimiter,
} from '@/middlewares/rateLimit';
import { validateQuery, validateRequest } from '@/middlewares/validateRequest';
import { attendanceController } from '@/modules/attendance/attendance.controller';
import { attendanceValidation } from '@/modules/attendance/attendance.validation';

/**
 * The only routes in this application with no `auth()` middleware.
 *
 * That is not an oversight. Students are not `User` rows — `users` holds ADMIN
 * login accounts only — so there is no credential for the attendance form to
 * present. What replaces authentication here is the pair of checks on every
 * request: the handle must resolve to a member currently in the guild
 * (Golden Rule 3, enforced in the service on both endpoints), and the caller
 * must be within its per-IP budget.
 *
 * Any route added to this router inherits that exposure. Give it a limiter.
 */
const router = express.Router();

// Live membership + already-submitted-today check for the form's badge.
router.get(
  '/verify-user',
  verifyUserRateLimiter,
  validateQuery(attendanceValidation.verifyUserQuerySchema),
  attendanceController.verifyUser,
);

// Record today's attendance.
router.post(
  '/submit',
  submitAttendanceRateLimiter,
  validateRequest(attendanceValidation.submitAttendanceValidationSchema),
  attendanceController.submitAttendance,
);

export const attendanceRouter: Router = router;
