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
  const result = await attendanceService.verifyEmail(req.query.email as string);

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
//
// Two distinct success branches, both 2xx, both telling the student the
// submission was acknowledged:
//
//   - `attendanceRecorded: true` — today's attendance was recorded in
//     every configured server the handle belongs to. The standard
//     success card is shown.
//
//   - `attendanceRecorded: false`, `reportQueued: true` — the submitted
//     handle does not match the pairing recorded for the email, and
//     the student ticked the "I cannot enter my real Discord username"
//     box. Today's attendance is NOT recorded. The discord-pairing
//     mismatch report is filed and queued for an admin. The form
//     renders a different success card ("Report filed — an admin will
//     review and you can submit cleanly afterwards").
//
// The 201 status is kept for the recorded branch so existing clients
// that branch on the status code remain unchanged. The report-only
// branch uses 202 Accepted with a different message — the work
// (recording today's attendance) is accepted as pending the
// administrator's review.
const submitAttendance = catchAsync(async (req, res) => {
  const result = await attendanceService.submitAttendance(req.body);

  if (result.attendanceRecorded) {
    sendResponse(res, {
      success: true,
      statusCode: httpStatus.CREATED,
      message: `Attendance submitted successfully for ${result.attendanceDate}`,
      data: result,
    });

    return;
  }

  sendResponse(res, {
    success: true,
    statusCode: httpStatus.ACCEPTED,
    message: `Discord pairing mismatch report filed for ${result.attendanceDate}. An administrator will review it; once the pairing is confirmed, your next submission will be recorded as today's attendance.`,
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
