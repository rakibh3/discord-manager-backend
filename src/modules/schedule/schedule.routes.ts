import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { validateRequest } from '@/middlewares/validateRequest';
import { scheduleController } from '@/modules/schedule/schedule.controller';
import { scheduleValidation } from '@/modules/schedule/schedule.validation';

/**
 * Channel schedule administration.
 *
 * Every route is admin-only. These endpoints decide when ~5,000 students may
 * post, and the manual ones change the channel immediately — there is no
 * student-facing reason to reach any of them, unlike the attendance router.
 *
 * The manual open/lock actions live here rather than under `/api/discord`
 * because this module owns channel state end to end: "open on a timer" and
 * "open now" call the same helper, and splitting them across two modules would
 * put two callers of one behaviour in two places. `/api/discord` stays what it
 * is — bot connection and member-sync status.
 */
const router = express.Router();

// Stored schedule + next run times + live channel state + last run outcome
router.get(
  '/daily-update',
  auth(UserRole.ADMIN),
  scheduleController.getSchedule,
);

// Change the times, weekdays, or enabled flag. Takes effect without a restart.
router.patch(
  '/daily-update',
  auth(UserRole.ADMIN),
  validateRequest(scheduleValidation.updateScheduleValidationSchema),
  scheduleController.updateSchedule,
);

// Force the channel state now, leaving the stored schedule untouched.
router.post(
  '/daily-update/open',
  auth(UserRole.ADMIN),
  validateRequest(scheduleValidation.channelStateValidationSchema),
  scheduleController.openChannel,
);

router.post(
  '/daily-update/lock',
  auth(UserRole.ADMIN),
  validateRequest(scheduleValidation.channelStateValidationSchema),
  scheduleController.lockChannel,
);

export const scheduleRouter: Router = router;
