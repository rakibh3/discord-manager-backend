import { UserRole } from '@generated/prisma/enums';
import express, { Router } from 'express';

import auth from '@/middlewares/auth';
import { validateQuery } from '@/middlewares/validateRequest';
import { dailyStatusController } from '@/modules/dailyStatus/dailyStatus.controller';
import { dailyStatusValidation } from '@/modules/dailyStatus/dailyStatus.validation';

/**
 * Daily status dashboard routes.
 *
 * Every route is admin-only.
 *
 * Route order matters: `/counts`, `/export`, and `/members/:memberId` are
 * declared before `/` so that Express routes match specific paths first.
 */
const router = express.Router();

// Summary overview counts for a date
router.get(
  '/counts',
  auth(UserRole.ADMIN),
  validateQuery(dailyStatusValidation.countsQuerySchema),
  dailyStatusController.getCounts,
);

// Filtered export (CSV attachment)
router.get(
  '/export',
  auth(UserRole.ADMIN),
  validateQuery(dailyStatusValidation.exportQuerySchema),
  dailyStatusController.exportData,
);

// Single member status and their messages for a date
router.get(
  '/members/:memberId',
  auth(UserRole.ADMIN),
  validateQuery(dailyStatusValidation.memberQuerySchema),
  dailyStatusController.getMemberStatus,
);

// Paginated member status list
router.get(
  '/',
  auth(UserRole.ADMIN),
  validateQuery(dailyStatusValidation.pageQuerySchema),
  dailyStatusController.getPage,
);

export const dailyStatusRouter: Router = router;
