import httpStatus from 'http-status';

import { announcementService } from '@/modules/announcement/announcement.service';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

// Stored message + schedule + rendered preview + scheduler state + today's send
const getAnnouncement = catchAsync(async (req, res) => {
  const result = await announcementService.getAnnouncement();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Attendance announcement retrieved successfully',
    data: result,
  });
});

// Change the message, the mention allowlist, or the schedule. No restart needed.
const updateAnnouncement = catchAsync(async (req, res) => {
  // `auth(UserRole.ADMIN)` populates `req.user` before this runs, so the
  // non-null assertion holds for every route this controller is mounted on.
  const result = await announcementService.updateAnnouncement(
    req.body,
    req.user!.id,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Attendance announcement updated successfully',
    data: result,
  });
});

// Render an unsaved body against today's live values, storing nothing
const previewAnnouncement = catchAsync(async (req, res) => {
  const result = await announcementService.previewAnnouncement(req.body);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Attendance announcement preview generated',
    data: result,
  });
});

// Post it now, independently of the schedule.
//
// Applies to every configured server unless `guildIds` narrows it. The status
// stays 200 when some servers posted and others failed — `data.summary` carries
// the counts and each entry its reason. An error status would say nothing
// happened, and the retry it invites would then be refused by the servers that
// already posted. Only a total failure raises (in the service).
const sendAnnouncement = catchAsync(async (req, res) => {
  const result = await announcementService.sendAnnouncementNow(
    req.body,
    req.user!.id,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message:
      result.summary.posted === result.summary.total
        ? 'Attendance announcement posted'
        : `Attendance announcement posted to ${result.summary.posted} of ${result.summary.total} server(s)`,
    data: result,
  });
});

export const announcementController = {
  getAnnouncement,
  updateAnnouncement,
  previewAnnouncement,
  sendAnnouncement,
};
