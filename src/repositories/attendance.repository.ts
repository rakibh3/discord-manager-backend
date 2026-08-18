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
 * Inserts one submission and carries the submitted contact details onto the
 * member's directory entry, in a single transaction.
 *
 * The two writes are one unit because a member whose phone and email were
 * updated by a submission that was then rejected as a duplicate would be a
 * silent inconsistency — the dashboard would show contact details for a day the
 * member has no attendance on. The insert runs first, so a duplicate aborts the
 * transaction before `discord_members` is touched at all.
 *
 * A duplicate for the same member and date raises Prisma P2002 on
 * `attendances_member_id_attendance_date_key`, and that is deliberately left to
 * propagate. Checking for an existing row first would not be safe anyway — two
 * concurrent submissions would both pass the check. The constraint is the
 * enforcement point (Golden Rule 7). Translating that P2002 into a message
 * naming the date is the service's job, not this layer's.
 *
 * Note the asymmetry, which is intended: the attendance row keeps `name`,
 * `email`, and `phone` exactly as submitted that day, while the directory entry
 * always carries the newest values. Updating a member's email must never
 * rewrite what an earlier day's report says they submitted.
 */
const createAttendanceWithMemberContact = async (
  input: CreateAttendanceInput,
): Promise<Attendance> =>
  prisma.$transaction(async (tx) => {
    const attendance = await tx.attendance.create({ data: input });

    await tx.discordMember.update({
      where: { id: input.memberId },
      data: { email: input.email, phone: input.phone },
    });

    return attendance;
  });

/**
 * Records the day's attendance for SEVERAL member records at once, and carries
 * the submitted contact details onto each of their directory entries.
 *
 * One transaction for all of them, deliberately. A handle that belongs to two
 * configured servers is two member records, and a student submitting once must
 * end up present in both or in neither — a partial commit would leave them
 * recorded in one server and silently missing in the other, which is the exact
 * failure multi-server support exists to remove.
 *
 * `memberIds` are the records that still need a row; ones that already have
 * today's attendance are filtered out by the caller, so a student who joined a
 * second server after submitting gets the missing row written without the
 * existing one being touched.
 */
const createAttendanceForMembers = async (
  inputs: CreateAttendanceInput[],
): Promise<Attendance[]> =>
  prisma.$transaction(async (tx) => {
    const created: Attendance[] = [];

    for (const input of inputs) {
      created.push(await tx.attendance.create({ data: input }));

      await tx.discordMember.update({
        where: { id: input.memberId },
        data: { email: input.email, phone: input.phone },
      });
    }

    return created;
  });

/**
 * Which of these member records already have a submission on this day.
 *
 * Backs both the per-server `alreadySubmitted` answer on verify-user and the
 * "all servers already recorded means duplicate, some means write the rest"
 * rule on submit.
 */
const findAttendanceForMembersOnDate = async (
  memberIds: string[],
  attendanceDate: string,
): Promise<Attendance[]> =>
  prisma.attendance.findMany({
    where: { memberId: { in: memberIds }, attendanceDate },
  });

/**
 * The submission for one member on one day, or `null`.
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
  createAttendanceWithMemberContact,
  createAttendanceForMembers,
  findAttendanceForMembersOnDate,
  findAttendanceByMemberAndDate,
  listAttendanceByDate,
};
