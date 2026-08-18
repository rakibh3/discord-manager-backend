import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { validateRequest } from '@/middlewares/validateRequest';
import { announcementController } from '@/modules/announcement/announcement.controller';
import { announcementValidation } from '@/modules/announcement/announcement.validation';

/**
 * Attendance announcement administration.
 *
 * Every route is admin-only, and nothing here is student-facing — unlike
 * `attendanceRouter`, which is deliberately unauthenticated because students
 * have no account. These endpoints write the message ~5,000 people read every
 * evening and can trigger a mass mention immediately; there is no version of
 * this that belongs on the public form's origin.
 */
const router = express.Router();

// Message + schedule + rendered preview + scheduler state + today's send
router.get(
  '/attendance',
  auth(UserRole.ADMIN),
  announcementController.getAnnouncement,
);

// Edit the message, the mention allowlist, or the schedule
router.patch(
  '/attendance',
  auth(UserRole.ADMIN),
  validateRequest(announcementValidation.updateAnnouncementValidationSchema),
  announcementController.updateAnnouncement,
);

// Render an unsaved body without storing it, so a change can be read in full
// before it reaches the channel
router.post(
  '/attendance/preview',
  auth(UserRole.ADMIN),
  validateRequest(announcementValidation.previewAnnouncementValidationSchema),
  announcementController.previewAnnouncement,
);

// Post now, leaving the stored schedule untouched. `{ force: true }` is the
// only way to post a second time in one day.
router.post(
  '/attendance/send',
  auth(UserRole.ADMIN),
  validateRequest(announcementValidation.sendAnnouncementValidationSchema),
  announcementController.sendAnnouncement,
);

export const announcementRouter: Router = router;
