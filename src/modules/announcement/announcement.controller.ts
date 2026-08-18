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

// Post it now, independently of the schedule
const sendAnnouncement = catchAsync(async (req, res) => {
  const result = await announcementService.sendAnnouncementNow(
    req.body,
    req.user!.id,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Attendance announcement posted',
    data: result,
  });
});

export const announcementController = {
  getAnnouncement,
  updateAnnouncement,
  previewAnnouncement,
  sendAnnouncement,
};
