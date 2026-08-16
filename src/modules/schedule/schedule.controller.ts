import httpStatus from 'http-status';

import { scheduleService } from '@/modules/schedule/schedule.service';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

// Current schedule, next run times, live channel state & last run outcome
const getSchedule = catchAsync(async (req, res) => {
  const result = await scheduleService.getSchedule();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Channel schedule retrieved successfully',
    data: result,
  });
});

// Update the open/close times, active weekdays, or enabled flag
const updateSchedule = catchAsync(async (req, res) => {
  // `auth(UserRole.ADMIN)` populates `req.user` before this runs, so the
  // non-null assertion holds for every route this controller is mounted on.
  const result = await scheduleService.updateSchedule(req.body, req.user!.id);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Channel schedule updated successfully',
    data: result,
  });
});

// Force the channel open now, without changing the schedule
const openChannel = catchAsync(async (req, res) => {
  const result = await scheduleService.openChannelNow();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Daily update channel opened',
    data: result,
  });
});

// Force the channel locked now, without changing the schedule
const lockChannel = catchAsync(async (req, res) => {
  const result = await scheduleService.lockChannelNow();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Daily update channel locked',
    data: result,
  });
});

export const scheduleController = {
  getSchedule,
  updateSchedule,
  openChannel,
  lockChannel,
};
