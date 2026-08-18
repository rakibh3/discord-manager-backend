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

// The configured servers, so a dashboard can build a server filter without
// hard-coding IDs in the client.
const listServers = catchAsync(async (req, res) => {
  const result = discordService.listServers();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Configured Discord servers retrieved successfully',
    data: result,
  });
});

// Trigger a full member re-sync, for every configured server or one named one
const triggerSync = catchAsync(async (req, res) => {
  const result = await discordService.triggerMemberSync(req.body?.guildId);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.ACCEPTED,
    message:
      result.accepted.length === 1
        ? 'Member sync started'
        : `Member sync started for ${result.accepted.length} server(s)`,
    data: result,
  });
});

export const discordController = {
  getSyncStatus,
  listServers,
  triggerSync,
};
