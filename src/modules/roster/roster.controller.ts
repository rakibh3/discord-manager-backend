import { Request } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { runRosterUpload } from '@/middlewares/upload';
import { rosterService } from '@/modules/roster/roster.service';
import { rosterValidation } from '@/modules/roster/roster.validation';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

/**
 * Every handler is wrapped in `catchAsync` and answers through `sendResponse`.
 * No Prisma reaches this file.
 */

/**
 * The roster entry id from the path.
 *
 * Express 5 types a route parameter as `string | string[] | undefined`, and
 * these routes cannot match without an `:id`, so the guard is unreachable in
 * practice — but it is a check rather than a cast, because a non-null assertion
 * here would hand `undefined` or an array straight to a database lookup if the
 * route pattern ever changed. Mirrors `readReminderId`.
 */
const readEntryId = (req: Request): string => {
  const { id } = req.params;

  if (typeof id !== 'string' || id.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, 'A roster entry id is required');
  }

  return id;
};

/**
 * Load a spreadsheet into the roster.
 *
 * The upload middleware runs HERE rather than on the route so its failures
 * travel as `AppError` through `catchAsync`, the way every other failure in this
 * application does — a raw `MulterError` reaching the global handler would
 * surface as a 500 for what is plainly a 400.
 *
 * The status stays 200 when some rows were skipped. `data` carries the counts
 * and each rejected row its line number and reason. Reporting an error would
 * tell the administrator that nothing happened, and invite them to re-upload a
 * corrected sheet believing the first attempt never took — when in fact those
 * rows really did load.
 */
const importRoster = catchAsync(async (req, res) => {
  await runRosterUpload(req, res);

  // `auth(UserRole.ADMIN)` populates `req.user` before this runs.
  const result = await rosterService.importRoster(req.file, req.user!.id);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message:
      result.skipped > 0
        ? `Imported ${result.created + result.updated} of ${result.totalRows} row(s); ${result.skipped} skipped`
        : `Imported ${result.created + result.updated} row(s)`,
    data: result,
  });
});

const listRoster = catchAsync(async (req, res) => {
  // Parsed rather than read raw: `validateQuery` rejects a malformed query but
  // deliberately does not assign the coerced result back, because `req.query`
  // is a getter under Express 5.
  const query = rosterValidation.listRosterQuerySchema.parse(req.query);
  const { entries, total } = await rosterService.listRoster(query);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Roster retrieved successfully',
    meta: { page: query.page, limit: query.limit, total, status: query.status },
    data: entries,
  });
});

const listImports = catchAsync(async (req, res) => {
  const query = rosterValidation.listImportsQuerySchema.parse(req.query);
  const { imports, total } = await rosterService.listImports(query);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Roster import history retrieved successfully',
    meta: { page: query.page, limit: query.limit, total },
    data: imports,
  });
});

const updateEntry = catchAsync(async (req, res) => {
  const result = await rosterService.updateEntry(readEntryId(req), req.body);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Roster entry updated successfully',
    data: result,
  });
});

const deactivateEntry = catchAsync(async (req, res) => {
  const result = await rosterService.deactivateEntry(readEntryId(req));

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message:
      'Roster entry removed. It can be restored, and its record is kept.',
    data: result,
  });
});

const restoreEntry = catchAsync(async (req, res) => {
  const result = await rosterService.restoreEntry(readEntryId(req));

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Roster entry restored successfully',
    data: result,
  });
});

const getSettings = catchAsync(async (req, res) => {
  const result = await rosterService.getSettings();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Roster settings retrieved successfully',
    data: result,
  });
});

const updateSettings = catchAsync(async (req, res) => {
  const result = await rosterService.updateSettings(req.body, req.user!.id);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: result.enforceEmail
      ? 'Email verification is now required to submit attendance'
      : 'Email verification is now off; submissions are checked on Discord membership only',
    data: result,
  });
});

export const rosterController = {
  importRoster,
  listRoster,
  listImports,
  updateEntry,
  deactivateEntry,
  restoreEntry,
  getSettings,
  updateSettings,
};
