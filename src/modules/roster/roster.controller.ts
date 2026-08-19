import { Request } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { runRosterUpload } from '@/middlewares/upload';
import { rosterService } from '@/modules/roster/roster.service';
import { rosterValidation } from '@/modules/roster/roster.validation';
import { catchAsync } from '@/utils/catchAsync';
import { resolvePeriod } from '@/utils/dhakaDate';
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

/**
 * Read `daysOfWeek=0,1,2` as the integer array — `validateQuery` parses but
 * does not assign back under Express 5.
 */
const readDaysOfWeek = (req: Request): number[] | undefined => {
  const raw = req.query.daysOfWeek;

  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;

  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value));
};

/**
 * Translate the validated query into the resolved period the service consumes.
 *
 * The schema has already refused every malformed combination, so this only has
 * to read which of the two valid forms arrived.
 */
const readResolvedPeriod = (req: Request) =>
  resolvePeriod({
    date: req.query.date as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    daysOfWeek: readDaysOfWeek(req),
  });

/** Engagement overview counts for a date or a range. */
const getStatusCounts = catchAsync(async (req, res) => {
  const period = readResolvedPeriod(req);

  const { meta, counts } = await rosterService.getStatusCounts(period);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Roster status counts retrieved successfully',
    data: { meta, counts },
  });
});

/** Engagement listing for a date or a range. */
const getStatusPage = catchAsync(async (req, res) => {
  const period = readResolvedPeriod(req);
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 50);

  const resolved = rosterService.resolveRosterStatusPeriodInput(period);

  if (resolved.mode === 'date' && resolved.meta.mode === 'date') {
    const { meta, rows, total } = await rosterService.getStatusPage({
      date: resolved.meta.date,
      pairingState: req.query.pairingState as
        | 'all'
        | 'paired'
        | 'unpaired'
        | undefined,
      status: req.query.status as
        | 'COMPLETE'
        | 'MISSING_UPDATE'
        | 'MISSING_ATTENDANCE'
        | 'MISSING_BOTH'
        | 'NEVER_LINKED'
        | undefined,
      search: req.query.search as string | undefined,
      sortBy: req.query.sortBy as
        | 'name'
        | 'email'
        | 'status'
        | 'linkedAt'
        | undefined,
      sortDir: req.query.sortDir as 'asc' | 'desc' | undefined,
      page,
      limit,
    });

    sendResponse(res, {
      success: true,
      statusCode: httpStatus.OK,
      message: 'Roster status retrieved successfully',
      meta: { page, limit, total, ...meta },
      data: rows,
    });

    return;
  }

  if (resolved.mode === 'range' && resolved.meta.mode === 'range') {
    const { meta, rows, total } = await rosterService.getStatusPage({
      days: resolved.days,
      pairingState: req.query.pairingState as
        | 'all'
        | 'paired'
        | 'unpaired'
        | undefined,
      status: req.query.status as
        | 'COMPLETE'
        | 'MISSING_UPDATE'
        | 'MISSING_ATTENDANCE'
        | 'MISSING_BOTH'
        | 'NEVER_LINKED'
        | undefined,
      search: req.query.search as string | undefined,
      sortBy: req.query.sortBy as
        | 'name'
        | 'email'
        | 'status'
        | 'linkedAt'
        | undefined,
      sortDir: req.query.sortDir as 'asc' | 'desc' | undefined,
      page,
      limit,
    });

    sendResponse(res, {
      success: true,
      statusCode: httpStatus.OK,
      message: 'Roster status retrieved successfully',
      meta: { page, limit, total, ...meta },
      data: rows,
    });

    return;
  }

  throw new AppError(
    httpStatus.INTERNAL_SERVER_ERROR,
    'Period resolution mismatch',
  );
});

/** Engagement export (CSV attachment) for a date or a range. */
const exportStatus = catchAsync(async (req, res) => {
  const period = readResolvedPeriod(req);
  const resolved = rosterService.resolveRosterStatusPeriodInput(period);
  const format = req.query.format as 'csv' | 'xlsx' | undefined;

  if (resolved.mode === 'date' && resolved.meta.mode === 'date') {
    await rosterService.exportStatusCsv(
      {
        date: resolved.meta.date,
        pairingState: req.query.pairingState as
          | 'all'
          | 'paired'
          | 'unpaired'
          | undefined,
        status: req.query.status as
          | 'COMPLETE'
          | 'MISSING_UPDATE'
          | 'MISSING_ATTENDANCE'
          | 'MISSING_BOTH'
          | 'NEVER_LINKED'
          | undefined,
        search: req.query.search as string | undefined,
        sortBy: req.query.sortBy as
          | 'name'
          | 'email'
          | 'status'
          | 'linkedAt'
          | undefined,
        sortDir: req.query.sortDir as 'asc' | 'desc' | undefined,
        format,
      },
      res,
    );

    return;
  }

  if (resolved.mode === 'range' && resolved.meta.mode === 'range') {
    await rosterService.exportStatusCsv(
      {
        days: resolved.days,
        pairingState: req.query.pairingState as
          | 'all'
          | 'paired'
          | 'unpaired'
          | undefined,
        status: req.query.status as
          | 'COMPLETE'
          | 'MISSING_UPDATE'
          | 'MISSING_ATTENDANCE'
          | 'MISSING_BOTH'
          | 'NEVER_LINKED'
          | undefined,
        search: req.query.search as string | undefined,
        sortBy: req.query.sortBy as
          | 'name'
          | 'email'
          | 'status'
          | 'linkedAt'
          | undefined,
        sortDir: req.query.sortDir as 'asc' | 'desc' | undefined,
        format,
      },
      res,
    );

    return;
  }

  throw new AppError(
    httpStatus.INTERNAL_SERVER_ERROR,
    'Period resolution mismatch',
  );
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
  getStatusCounts,
  getStatusPage,
  exportStatus,
};
