import type { Request } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { discordPairingMismatchReportService } from '@/modules/discordPairingMismatchReport/discordPairingMismatchReport.service';
import { discordPairingMismatchReportValidation } from '@/modules/discordPairingMismatchReport/discordPairingMismatchReport.validation';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

/**
 * Every handler is wrapped in `catchAsync` and answers through
 * `sendResponse`. No Prisma reaches this file.
 */

/**
 * The report id from the path.
 *
 * Express 5 types a route parameter as `string | string[] | undefined`,
 * and these routes cannot match without an `:id`, so the guard is
 * unreachable in practice — but it is a check rather than a cast,
 * because a non-null assertion here would hand `undefined` or an array
 * straight to a database lookup if the route pattern ever changed.
 */
const readReportId = (req: Request): string => {
  const { id } = req.params;

  if (typeof id !== 'string' || id.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, 'A report id is required');
  }

  return id;
};

/** `GET /api/roster/discord-mismatch-reports` */
const listReports = catchAsync(async (req, res) => {
  const query =
    discordPairingMismatchReportValidation.listReportsQuerySchema.parse(
      req.query,
    );

  const { items, total } =
    await discordPairingMismatchReportService.listReports({
      status: query.status,
      search: query.search,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    });

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Discord pairing mismatch reports retrieved successfully',
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      status: query.status,
    },
    data: { items, total },
  });
});

/** `POST /api/roster/discord-mismatch-reports/:id/action` */
const actOnReport = catchAsync(async (req, res) => {
  const reportId = readReportId(req);
  const body =
    discordPairingMismatchReportValidation.actOnReportValidationSchema.parse(
      req.body,
    );

  const outcome = await discordPairingMismatchReportService.actOnReport({
    reportId,
    action: body.action,
    reviewingAdminId: req.user!.id,
  });

  if (outcome.kind === 'error') {
    throw outcome.error;
  }

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message:
      body.action === 'reassign'
        ? 'Report reassigned; the entry pairing has been updated'
        : 'Report dismissed; the entry pairing is unchanged',
    data: outcome.result,
  });
});

export const discordPairingMismatchReportController = {
  listReports,
  actOnReport,
};