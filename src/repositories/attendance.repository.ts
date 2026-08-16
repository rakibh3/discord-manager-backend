import type { Attendance } from '@generated/prisma/client';
import type { AttendanceStatus } from '@generated/prisma/enums';

import { prisma } from '@/lib/prisma';

/**
 * Data access for `attendances`.
 *
 * Repositories own Prisma and nothing else: no `AppError`, no HTTP status
 * codes, no `req`. They return data or `null` — deciding that a `null` is a 404
 * belongs to the calling service. This layer exists because the attendance
 * domain has non-HTTP callers (the Discord gateway handlers and, later, the
 * BullMQ worker) that must share these queries with the Express modules.
 */

export type CreateAttendanceInput = {
  memberId: string;
  name: string;
  email: string;
  phone: string;
  /** `YYYY-MM-DD`, Asia/Dhaka. Derive with `getDhakaDate()`. */
  attendanceDate: string;
  status?: AttendanceStatus;
};

/**
 * Inserts one submission.
 *
 * A duplicate for the same member and date raises Prisma P2002 on
 * `attendances_member_id_attendance_date_key`, and that is deliberately left to
 * propagate: `globalErrorHandler` already shapes P2002 as a duplicate response.
 * Checking for an existing row first would not be safe anyway — two concurrent
 * submissions would both pass the check. The constraint is the enforcement point.
 */
const createAttendance = async (
  input: CreateAttendanceInput,
): Promise<Attendance> => prisma.attendance.create({ data: input });

/**
 * The submission for one member on one day, or `null`.
 * Backs the `alreadySubmitted` flag on the verify-user endpoint.
 * Served by the `(member_id, attendance_date)` unique index.
 */
const findAttendanceByMemberAndDate = async (
  memberId: string,
  attendanceDate: string,
): Promise<Attendance | null> =>
  prisma.attendance.findUnique({
    where: { memberId_attendanceDate: { memberId, attendanceDate } },
  });

/**
 * Every submission on one day, newest first, with the member each belongs to.
 * Served by the `attendance_date` index.
 */
const listAttendanceByDate = async (attendanceDate: string) =>
  prisma.attendance.findMany({
    where: { attendanceDate },
    orderBy: { submittedAt: 'desc' },
    include: {
      member: {
        select: {
          id: true,
          discordUserId: true,
          discordUsername: true,
          displayName: true,
          isInGuild: true,
        },
      },
    },
  });

// The "attendance submitted today" dashboard figure deliberately does NOT live
// here. A plain `count` over this table would include members who have since
// left the guild, disagreeing with `getDailyStatusCounts`, which excludes them.
// That number belongs to the aggregation, where it stays consistent with the
// other six.

export const attendanceRepository = {
  createAttendance,
  findAttendanceByMemberAndDate,
  listAttendanceByDate,
};
