import type { Request } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { dailyStatusService } from '@/modules/dailyStatus/dailyStatus.service';
import type { DailyStatus } from '@/repositories/dailyStatus.repository';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

const readPaging = (query: Record<string, unknown>) => ({
  page: Number(query.page ?? 1),
  limit: Number(query.limit ?? 50),
});

const readMemberId = (req: Request): string => {
  const { memberId } = req.params;

  if (typeof memberId !== 'string' || memberId.length === 0) {
    throw new AppError(httpStatus.BAD_REQUEST, 'A member id is required');
  }

  return memberId;
};

// Overview figures for a given date
const getCounts = catchAsync(async (req, res) => {
  const result = await dailyStatusService.getCounts(
    req.query.date as string,
    req.query.guildId as string | undefined,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Daily status counts retrieved successfully',
    data: result,
  });
});

// Member status table with paging, filtering, and search
const getPage = catchAsync(async (req, res) => {
  const paging = readPaging(req.query);
  const { rows, total } = await dailyStatusService.getPage({
    date: req.query.date as string,
    guildId: req.query.guildId as string | undefined,
    page: paging.page,
    limit: paging.limit,
    status: req.query.status as DailyStatus | undefined,
    search: req.query.search as string | undefined,
  });

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Daily status retrieved successfully',
    meta: { ...paging, total },
    data: rows,
  });
});

// Single member status and daily-update messages for a date
const getMemberStatus = catchAsync(async (req, res) => {
  const memberId = readMemberId(req);
  const result = await dailyStatusService.getMemberStatus(
    memberId,
    req.query.date as string,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Member daily status retrieved successfully',
    data: result,
  });
});

// Export filtered daily status as CSV attachment
const exportData = catchAsync(async (req, res) => {
  await dailyStatusService.exportCsv(
    {
      date: req.query.date as string,
      guildId: req.query.guildId as string | undefined,
      status: req.query.status as DailyStatus | undefined,
      search: req.query.search as string | undefined,
      format: req.query.format as 'csv' | 'xlsx' | undefined,
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
