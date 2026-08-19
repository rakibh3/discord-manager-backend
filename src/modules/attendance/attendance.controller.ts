import httpStatus from 'http-status';

import { attendanceService } from '@/modules/attendance/attendance.service';
import { catchAsync } from '@/utils/catchAsync';
import { sendResponse } from '@/utils/sendResponse';

// Live check: is this Discord handle a current member, and have they already
// submitted today? Always 200 — "not found" is a routine answer the form has to
// render, not a failure. `verified` and `alreadySubmitted` sit inside `data`
// because `sendResponse` owns the envelope; the PID sketches them top-level.
const verifyUser = catchAsync(async (req, res) => {
  const result = await attendanceService.verifyUser(
    req.query.username as string,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: result.verified
      ? result.alreadySubmitted
        ? `You have already submitted your attendance for today (${result.attendanceDate}).`
        : 'Discord username verified'
      : 'This Discord username was not found in our Discord server. Please check the username, or join the server first.',
    data: result,
  });
});

// Live check: is this email on the active enrolment roster? Always 200 —
// "not enrolled" is the routine answer the form has to render as a hint, not
// a failure. Same envelope shape as `verifyUser` so the form's badge and the
// submit-time check cannot drift on what "verified" means.
const verifyEmail = catchAsync(async (req, res) => {
  const result = await attendanceService.verifyEmail(
    req.query.email as string,
  );

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: result.verified
      ? 'Email verified'
      : result.emailVerificationRequired
        ? 'This email address is not on our enrolled student list. Please use the email address you enrolled with, or contact an admin.'
        : 'Roster check is currently disabled by an admin; no enrolment check was performed.',
    data: result,
  });
});

// Record today's attendance from the web form.
const submitAttendance = catchAsync(async (req, res) => {
  const result = await attendanceService.submitAttendance(req.body);

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.CREATED,
    message: `Attendance submitted successfully for ${result.attendanceDate}`,
    data: result,
  });
});

// Public projection of the submission window for the attendance form.
const getAttendanceWindow = catchAsync(async (_req, res) => {
  const result = await attendanceService.getAttendanceWindow();

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.OK,
    message: 'Attendance window retrieved successfully',
    data: result,
  });
});

export const attendanceController = {
  verifyUser,
  verifyEmail,
  submitAttendance,
  getAttendanceWindow,
};
