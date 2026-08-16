import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { validateQuery, validateRequest } from '@/middlewares/validateRequest';
import { reminderController } from '@/modules/reminder/reminder.controller';
import { reminderValidation } from '@/modules/reminder/reminder.validation';

/**
 * Reminder broadcast administration.
 *
 * Every route is admin-only. `POST /send` DMs thousands of students and cannot
 * be undone, and the reads expose who did not submit — there is no student-
 * facing reason to reach any of them, unlike the attendance router.
 *
 * Route order matters: `/targets` and `/status` are declared before `/:id`, or
 * Express would match them as broadcast identifiers and answer 404 for both.
 */
const router = express.Router();

// Who would be reminded for a date. Sends nothing.
router.get(
  '/targets',
  auth(UserRole.ADMIN),
  validateQuery(reminderValidation.targetsQueryValidationSchema),
  reminderController.getTargets,
);

// Queue and worker health, including the last fallback announcement's outcome.
router.get('/status', auth(UserRole.ADMIN), reminderController.getStatus);

// Start a broadcast. Answers 202 — nothing is delivered yet when it returns.
router.post(
  '/send',
  auth(UserRole.ADMIN),
  validateRequest(reminderValidation.sendReminderValidationSchema),
  reminderController.sendReminder,
);

// Broadcast history.
router.get(
  '/',
  auth(UserRole.ADMIN),
  validateQuery(reminderValidation.listRemindersQueryValidationSchema),
  reminderController.listReminders,
);

// Live progress for one broadcast.
router.get('/:id', auth(UserRole.ADMIN), reminderController.getReminder);

// Per-recipient delivery outcomes.
router.get(
  '/:id/recipients',
  auth(UserRole.ADMIN),
  validateQuery(reminderValidation.listRecipientsQueryValidationSchema),
  reminderController.getReminderRecipients,
);

// Stop a broadcast in flight.
router.post(
  '/:id/cancel',
  auth(UserRole.ADMIN),
  reminderController.cancelReminder,
);

export const reminderRouter: Router = router;
