import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { validateQuery, validateRequest } from '@/middlewares/validateRequest';
import { rosterController } from '@/modules/roster/roster.controller';
import { rosterValidation } from '@/modules/roster/roster.validation';

/**
 * The enrolment roster. Every route is admin-only, without exception.
 *
 * This router holds the names, email addresses, and phone numbers of every
 * enrolled student — several thousand people's contact details — and the switch
 * that decides who may submit attendance at all. Unlike `attendanceRouter`,
 * there is no membership check that could stand in for a credential here, and
 * no student-facing reason to reach any of it.
 *
 * A public route added to this router would be a data breach, not a feature.
 */
const router = express.Router();

// The settings routes come BEFORE `/:id`, or Express matches "settings" as an
// entry ID and answers 404 for the one endpoint that arms the feature.
router.get('/settings', auth(UserRole.ADMIN), rosterController.getSettings);

router.patch(
  '/settings',
  auth(UserRole.ADMIN),
  validateRequest(rosterValidation.updateSettingsValidationSchema),
  rosterController.updateSettings,
);

// Past imports: who uploaded what, when, and what it did.
router.get(
  '/imports',
  auth(UserRole.ADMIN),
  validateQuery(rosterValidation.listImportsQuerySchema),
  rosterController.listImports,
);

// Load a spreadsheet. Upserts by email and can never remove anybody — see
// `roster.repository.ts`. The multipart parsing runs inside the controller so
// its failures arrive as `AppError`.
router.post('/import', auth(UserRole.ADMIN), rosterController.importRoster);

router.get(
  '/',
  auth(UserRole.ADMIN),
  validateQuery(rosterValidation.listRosterQuerySchema),
  rosterController.listRoster,
);

router.patch(
  '/:id',
  auth(UserRole.ADMIN),
  validateRequest(rosterValidation.updateEntryValidationSchema),
  rosterController.updateEntry,
);

// Deactivates. The row is kept so attendance history and the audit trail stay
// intact, and so a mistaken removal is reversible.
router.delete('/:id', auth(UserRole.ADMIN), rosterController.deactivateEntry);

router.patch(
  '/:id/restore',
  auth(UserRole.ADMIN),
  rosterController.restoreEntry,
);

// The roster engagement read model — overview counts, paginated listing, and
// a CSV export of the same filtered set.
//
// DECLARED BEFORE `/:id` for the same reason `/settings` is: Express would
// otherwise match `status` (and `status/counts`, `status/export`) as an entry
// ID and answer 404 for the whole engagement surface.
router.get(
  '/status/counts',
  auth(UserRole.ADMIN),
  validateQuery(rosterValidation.statusCountsQuerySchema),
  rosterController.getStatusCounts,
);

router.get(
  '/status/export',
  auth(UserRole.ADMIN),
  validateQuery(rosterValidation.statusExportQuerySchema),
  rosterController.exportStatus,
);

router.get(
  '/status',
  auth(UserRole.ADMIN),
  validateQuery(rosterValidation.statusQuerySchema),
  rosterController.getStatusPage,
);

export const rosterRouter: Router = router;
