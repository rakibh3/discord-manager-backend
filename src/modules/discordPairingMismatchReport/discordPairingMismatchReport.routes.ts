import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { validateQuery, validateRequest } from '@/middlewares/validateRequest';
import { discordPairingMismatchReportController } from '@/modules/discordPairingMismatchReport/discordPairingMismatchReport.controller';
import { discordPairingMismatchReportValidation } from '@/modules/discordPairingMismatchReport/discordPairingMismatchReport.validation';

/**
 * Admin-only routes for the discord-pairing-mismatch reports.
 *
 * The listing and the action endpoint sit behind the same administrator
 * token middleware the rest of the roster-admin surface uses. They
 * inherit the same audit-log entry format — the report identifier, the
 * reviewing administrator, and the action time are recorded on every
 * final action through the schema's `reviewed_by_admin_id` and
 * `reviewed_at` columns.
 */
const router = express.Router();

router.get(
  '/',
  auth(UserRole.ADMIN),
  validateQuery(
    discordPairingMismatchReportValidation.listReportsQuerySchema,
  ),
  discordPairingMismatchReportController.listReports,
);

router.post(
  '/:id/action',
  auth(UserRole.ADMIN),
  validateRequest(
    discordPairingMismatchReportValidation.actOnReportValidationSchema,
  ),
  discordPairingMismatchReportController.actOnReport,
);

export const discordPairingMismatchReportRouter: Router = router;