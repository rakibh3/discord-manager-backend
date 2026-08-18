import { Prisma } from '@generated/prisma/client';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { isWithinWindow } from '@/lib/scheduler/channelSchedule.scheduler';
import { attendanceRepository } from '@/repositories/attendance.repository';
import { channelScheduleRepository } from '@/repositories/channelSchedule.repository';
import {
  memberRepository,
  VerifiedMember,
} from '@/repositories/member.repository';
import {
  addDhakaDays,
  DHAKA_TIMEZONE,
  dhakaWallClockToInstant,
  getDhakaDate,
  getDhakaWeekday,
} from '@/utils/dhakaDate';
import { normalizeDiscordUsername } from '@/utils/discordUsername';

/**
 * Business rules for the public attendance form.
 *
 * The one thing to keep in mind when changing this file: `verifyUser` is a UI
 * affordance and `submitAttendance` is the enforcement point. Nothing forces a
 * client to call the first — a direct `POST` is trivially constructed — so the
 * write path re-runs every check itself. Golden Rule 3 cannot be satisfied by a
 * browser.
 */

/** What the form is told about a handle it asked about. */
type TVerificationResult = {
  verified: boolean;
  alreadySubmitted: boolean;
  /** Today's Dhaka date, so the form can name it in its own messages. */
  attendanceDate: string;
  member: VerifiedMember | null;
};

export type TSubmitAttendancePayload = {
  name: string;
  phone: string;
  email: string;
  discordUsername: string;
};

/** The message an unknown or departed handle gets, from either endpoint. */
const NOT_A_MEMBER_MESSAGE =
  'This Discord username was not found in our Discord server. Please check the username, or join the server first.';

/**
 * Resolves a raw form input to the guild member holding it, or `null`.
 *
 * Both endpoints go through here so there is exactly one definition of
 * "verified". If the verify endpoint and the submit endpoint ever disagreed
 * about what counts as a member, the form would show a ✅ badge on a handle that
 * cannot submit.
 *
 * The repository already collapses "no such row" and "row exists but the member
 * left" into `null`, and this layer keeps them collapsed: both produce the same
 * outcome, and telling them apart would let anyone confirm that a specific
 * person used to be in the server.
 */
const resolveActiveMember = async (
  rawUsername: string,
): Promise<VerifiedMember | null> => {
  const normalized = normalizeDiscordUsername(rawUsername);

  return memberRepository.findActiveMemberByUsername(normalized);
};

/**
 * Whether a P2002 is the one-attendance-per-member-per-day constraint firing,
 * as opposed to some other unique constraint on the same write.
 *
 * Matches against the serialized `meta` rather than reading `meta.target`,
 * because **`target` is `undefined` under the `@prisma/adapter-pg` driver
 * adapter this project uses**. The constraint arrives nested instead, at
 * `meta.driverAdapterError.cause.constraint.fields` — verified against a live
 * duplicate:
 *
 *   { modelName: 'Attendance', driverAdapterError: { cause: {
 *       originalCode: '23505', kind: 'UniqueConstraintViolation',
 *       constraint: { fields: ['member_id', 'attendance_date'] } } } }
 *
 * That nested path is driver-specific and not part of Prisma's documented error
 * contract, so reading it field-by-field would break on an adapter change and do
 * so silently — the duplicate would quietly fall through to the generic
 * "Duplicate Error" instead of the message naming the date. Searching the
 * serialized form for the column name works against `target`, against the
 * adapter's nested shape, and against whatever replaces either.
 *
 * `attendance_date` appears in no other constraint in the schema, so a match
 * cannot be a false positive.
 */
const isDuplicateAttendanceError = (
  error: Prisma.PrismaClientKnownRequestError,
): boolean =>
  error.code === 'P2002' &&
  JSON.stringify(error.meta ?? {}).includes('attendance_date');

/**
 * Reports whether a handle belongs to a current guild member, and whether that
 * member has already submitted today.
 *
 * Answers `verified: false` rather than throwing for an unknown handle: not
 * found is the routine answer here, and the form has to render something either
 * way. `member` is `null` whenever `verified` is false — no partial disclosure
 * about handles that are not active members.
 */
const verifyUser = async (
  rawUsername: string,
): Promise<TVerificationResult> => {
  // Resolved once and threaded through. A second call could land on the next
  // day at 23:59:59.9 and report a date that disagrees with the lookup below.
  const attendanceDate = getDhakaDate();

  const member = await resolveActiveMember(rawUsername);

  if (!member) {
    return {
      verified: false,
      alreadySubmitted: false,
      attendanceDate,
      member: null,
    };
  }

  const existing = await attendanceRepository.findAttendanceByMemberAndDate(
    member.id,
    attendanceDate,
  );

  return {
    verified: true,
    alreadySubmitted: Boolean(existing),
    attendanceDate,
    member,
  };
};

/**
 * Records today's attendance for a verified member.
 *
 * Re-verifies membership regardless of any earlier `verifyUser` call: the two
 * requests are separated by however long the student takes to fill the form, and
 * `guildMemberRemove` fires in between often enough to matter in a 5,000-member
 * server.
 *
 * There is deliberately no "have they already submitted?" read before the write.
 * The unique constraint decides, and two simultaneous submissions still resolve
 * to one row — a pre-check would let both through (Golden Rule 7).
 */
const submitAttendance = async (payload: TSubmitAttendancePayload) => {
  const attendanceDate = getDhakaDate();

  const member = await resolveActiveMember(payload.discordUsername);

  if (!member) {
    throw new AppError(httpStatus.NOT_FOUND, NOT_A_MEMBER_MESSAGE);
  }

  try {
    const attendance =
      await attendanceRepository.createAttendanceWithMemberContact({
        memberId: member.id,
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
        attendanceDate,
      });

    return {
      attendanceDate,
      submittedAt: attendance.submittedAt,
      member,
    };
  } catch (error) {
    // P2002 is normally shaped by `globalErrorHandler`, but that handler has no
    // way to know which date the student already submitted for, and PID §3.4
    // requires the message to name it. Only the attendance constraint is
    // translated; any other P2002 is re-thrown for the central handler.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      isDuplicateAttendanceError(error)
    ) {
      throw new AppError(
        httpStatus.CONFLICT,
        `You have already submitted your attendance for today (${attendanceDate}).`,
      );
    }

    throw error;
  }
};

export type TAttendanceWindowResult = {
  isOpen: boolean;
  date: string;
  openTime: string;
  closeTime: string;
  daysOfWeek: number[];
  enabled: boolean;
  timezone: string;
  nextOpenAt: Date | null;
  closesAt: Date | null;
};

/**
 * Projection of the current attendance submission window for the public form.
 *
 * Sourced entirely from the `channel_schedules` row and the Dhaka clock.
 * Deliberately performs no external I/O (no Discord API calls) so high student
 * traffic cannot exhaust Discord rate limits or degrade member sync.
 */
const getAttendanceWindow = async (): Promise<TAttendanceWindowResult> => {
  const schedule = await channelScheduleRepository.getOrCreateSchedule();
  const now = new Date();
  const today = getDhakaDate(now);

  // `isWithinWindow` deliberately ignores `enabled` because the scheduler treats
  // disabled as "leave the channel alone", whereas here disabled means the form never opens.
  const isOpen = schedule.enabled && isWithinWindow(schedule, now);

  const closesAt = isOpen
    ? dhakaWallClockToInstant(today, schedule.closeTime)
    : null;

  let nextOpenAt: Date | null = null;
  if (schedule.enabled) {
    // Scan up to 8 candidate days starting from today's Dhaka civil date (offset 0..7).
    // 8 rather than 7 so a single-day schedule already past today resolves to next week.
    for (let offset = 0; offset <= 7; offset++) {
      const candidateDate = addDhakaDays(today, offset);
      const candidateInstant = dhakaWallClockToInstant(
        candidateDate,
        schedule.openTime,
      );
      const candidateWeekday = getDhakaWeekday(candidateInstant);

      if (schedule.daysOfWeek.includes(candidateWeekday)) {
        if (candidateInstant.getTime() > now.getTime()) {
          nextOpenAt = candidateInstant;
          break;
        }
      }
    }
  }

  // The explicit literal is the leak barrier: `getOrCreateSchedule()` returns
  // `TChannelScheduleWithEditor` carrying `updatedBy` (admin name and email).
  // A spread-and-omit would expose any field later added to the row or the include,
  // on the one route reachable without a token.
  return {
    isOpen,
    date: today,
    openTime: schedule.openTime,
    closeTime: schedule.closeTime,
    daysOfWeek: schedule.daysOfWeek,
    enabled: schedule.enabled,
    timezone: DHAKA_TIMEZONE,
    nextOpenAt,
    closesAt,
  };
};

export const attendanceService = {
  verifyUser,
  submitAttendance,
  getAttendanceWindow,
};
