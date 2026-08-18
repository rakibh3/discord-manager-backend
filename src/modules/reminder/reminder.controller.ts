import type { ReminderDeliveryStatus } from '@generated/prisma/enums';
import type { Request } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { reminderService } from '@/modules/reminder/reminder.service';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

/** Paging defaults, mirrored into `meta` so the client can page without guessing. */
const readPaging = (query: Record<string, unknown>) => ({
  page: Number(query.page ?? 1),
  limit: Number(query.limit ?? 50),
});

/**
 * The broadcast id from the path.
 *
 * Express 5 types a route parameter as `string | string[] | undefined`, and
 * these routes cannot match without an `:id`, so the guard is unreachable in
 * practice — but it is a check rather than a cast, because a non-null assertion
 * here would hand `undefined` or an array straight to a database lookup if the
 * route pattern ever changed.
 */
const readReminderId = (req: Request): string => {
  const { id } = req.params;

  if (typeof id !== 'string' || id.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'A reminder broadcast id is required',
    );
  }

  return id;
};

// Who would be reminded for a date — the confirm step before anything is sent
const getTargets = catchAsync(async (req, res) => {
  const result = await reminderService.previewTargets(
    req.query.date as string,
    req.query.guildIds as string[] | undefined,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Reminder targets retrieved successfully',
    data: result,
  });
});

// Start a broadcast. 202: nothing has been delivered when this returns.
const sendReminder = catchAsync(async (req, res) => {
  // `auth(UserRole.ADMIN)` populates `req.user` before this runs, so the
  // non-null assertion holds for every route this controller is mounted on.
  const result = await reminderService.startBroadcast(req.body, req.user!.id);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.ACCEPTED,
    message: `Reminder broadcast queued for ${result.targetCount} member(s). Delivery is paced and runs in the background.`,
    data: result,
  });
});

// Broadcast history, newest first
const listReminders = catchAsync(async (req, res) => {
  const paging = readPaging(req.query);
  const { rows, total } = await reminderService.listBroadcasts(paging);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Reminder broadcasts retrieved successfully',
    meta: { ...paging, total },
    data: rows,
  });
});

// Live progress for one broadcast — what Phase 7's SSE endpoint will stream
const getReminder = catchAsync(async (req, res) => {
  const result = await reminderService.getBroadcast(readReminderId(req));

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Reminder broadcast retrieved successfully',
    data: result,
  });
});

// Per-recipient delivery outcomes — the audit view
const getReminderRecipients = catchAsync(async (req, res) => {
  const paging = readPaging(req.query);
  const { rows, total } = await reminderService.listBroadcastRecipients(
    readReminderId(req),
    {
      ...paging,
      status: req.query.status as ReminderDeliveryStatus | undefined,
    },
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Reminder recipients retrieved successfully',
    meta: { ...paging, total },
    data: rows,
  });
});

// Stop a broadcast in flight
const cancelReminder = catchAsync(async (req, res) => {
  const result = await reminderService.cancelBroadcast(readReminderId(req));

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Reminder broadcast cancelled',
    data: result,
  });
});

// Queue and worker health
const getStatus = catchAsync(async (req, res) => {
  const result = await reminderService.getQueueStatus();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Reminder queue status retrieved successfully',
    data: result,
  });
});

export const reminderController = {
  getTargets,
  sendReminder,
  listReminders,
  getReminder,
  getReminderRecipients,
  cancelReminder,
  getStatus,
};
