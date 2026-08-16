import httpStatus from 'http-status';

import { discordService } from '@/modules/discord/discord.service';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

// Get Discord bot connection state and member sync status
const getSyncStatus = catchAsync(async (req, res) => {
  const result = await discordService.getSyncStatusFromDB();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Discord sync status retrieved successfully',
    data: result,
  });
});

// Trigger a full guild member re-sync
const triggerSync = catchAsync(async (req, res) => {
  const result = await discordService.triggerMemberSync();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.ACCEPTED,
    message: 'Member sync started',
    data: result,
  });
});

export const discordController = {
  getSyncStatus,
  triggerSync,
};
