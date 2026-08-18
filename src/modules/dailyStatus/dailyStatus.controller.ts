import type { Request } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { dailyStatusService } from '@/modules/dailyStatus/dailyStatus.service';
import type {
  DailyStatus,
  DailyStatusRangeSortColumn,
  RangeStatus,
} from '@/repositories/dailyStatus.repository';
import { catchAsync } from '@/utils/catchAsync';
import { resolvePeriod, type TResolvedPeriod } from '@/utils/dhakaDate';
import { sendResponse } from '@/utils/sendResponse';

const readPaging = (query: Record<string, unknown>) => ({
  page: Number(query.page ?? 1),
  limit: Number(query.limit ?? 50),
});

/**
 * The period this request asked about.
 *
 * The schema has already refused every combination but the two valid ones, so
 * this only has to read which of them arrived. `req.query` values survive
 * validation as parsed values because `validateQuery` parses but deliberately
 * does not assign back — `req.query` is a getter under Express 5 — so the
 * coerced `daysOfWeek` is re-read from the raw string here.
 */
const readPeriod = (req: Request): TResolvedPeriod =>
  resolvePeriod({
    date: req.query.date as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    daysOfWeek: readDaysOfWeek(req),
  });

/** `daysOfWeek=0,1,2` as the validated integer array. */
const readDaysOfWeek = (req: Request): number[] | undefined => {
  const raw = req.query.daysOfWeek;

  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;

  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value));
};

const readFilters = (req: Request) => ({
  guildId: req.query.guildId as string | undefined,
  search: req.query.search as string | undefined,
  rangeStatus: req.query.rangeStatus as RangeStatus | undefined,
  minMissedBothDays:
    req.query.minMissedBothDays === undefined
      ? undefined
      : Number(req.query.minMissedBothDays),
});

const readMemberId = (req: Request): string => {
  const { memberId } = req.params;

  if (typeof memberId !== 'string' || memberId.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, 'A member id is required');
  }

  return memberId;
};

// Overview figures for a date or a range
const getCounts = catchAsync(async (req, res) => {
  const period = readPeriod(req);
  const guildId = req.query.guildId as string | undefined;

  const result =
    period.mode === 'range'
      ? await dailyStatusService.getRangeCounts(period, guildId)
      : {
          mode: 'date' as const,
          ...(await dailyStatusService.getCounts(period.date, guildId)),
        };

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Daily status counts retrieved successfully',
    data: result,
  });
});

// Member status table with paging, filtering, and search, for a date or a range
const getPage = catchAsync(async (req, res) => {
  const paging = readPaging(req.query);
  const period = readPeriod(req);
  const filters = readFilters(req);

  if (period.mode === 'range') {
    const { rows, total, meta } = await dailyStatusService.getRangePage({
      ...period,
      ...filters,
      page: paging.page,
      limit: paging.limit,
      sortBy: req.query.sortBy as DailyStatusRangeSortColumn | undefined,
      sortDir: req.query.sortDir as 'asc' | 'desc' | undefined,
    });

    sendResponse(res, {
      success: true,
      statusCode: httpStatus.OK,
      message: 'Daily status retrieved successfully',
      meta: { ...paging, total, ...meta },
      data: rows,
    });

    return;
  }

  const { rows, total } = await dailyStatusService.getPage({
    date: period.date,
    guildId: filters.guildId,
    page: paging.page,
    limit: paging.limit,
    status: req.query.status as DailyStatus | undefined,
    search: filters.search,
  });

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Daily status retrieved successfully',
    meta: { ...paging, total, mode: 'date', date: period.date },
    data: rows,
  });
});

// Single member status and daily-update messages, for a date or a range
const getMemberStatus = catchAsync(async (req, res) => {
  const memberId = readMemberId(req);
  const period = readPeriod(req);

  const result =
    period.mode === 'range'
      ? await dailyStatusService.getMemberRangeStatus(memberId, period)
      : {
          mode: 'date' as const,
          date: period.date,
          ...(await dailyStatusService.getMemberStatus(memberId, period.date)),
        };

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Member daily status retrieved successfully',
    data: result,
  });
});

// Export filtered daily status as CSV attachment, for a date or a range
const exportData = catchAsync(async (req, res) => {
  const period = readPeriod(req);
  const filters = readFilters(req);
  const format = req.query.format as 'csv' | 'xlsx' | undefined;

  if (period.mode === 'range') {
    await dailyStatusService.exportRangeCsv(
      { ...period, ...filters, format },
      res,
    );

    return;
  }

  await dailyStatusService.exportCsv(
    {
      date: period.date,
      guildId: filters.guildId,
      status: req.query.status as DailyStatus | undefined,
      search: filters.search,
      format,
    },
    res,
  );
});

export const dailyStatusController = {
  getCounts,
  getPage,
  getMemberStatus,
  exportData,
};
