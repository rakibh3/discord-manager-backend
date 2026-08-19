import { Prisma } from '@generated/prisma/client';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { getGuildConfig } from '@/lib/discord/client';
import { guildLabel } from '@/lib/discord/fanout';
import { isWithinWindow } from '@/lib/scheduler/channelSchedule.scheduler';
import { attendanceRepository } from '@/repositories/attendance.repository';
import { channelScheduleRepository } from '@/repositories/channelSchedule.repository';
import {
  memberRepository,
  VerifiedMember,
} from '@/repositories/member.repository';
import { rosterRepository } from '@/repositories/roster.repository';
import {
  addDhakaDays,
  DHAKA_TIMEZONE,
  dhakaWallClockToInstant,
  getDhakaDate,
  getDhakaWeekday,
} from '@/utils/dhakaDate';
import { normalizeDiscordUsername } from '@/utils/discordUsername';
import { normalizeRosterEmail } from '@/utils/rosterEmail';

/**
 * Business rules for the public attendance form.
 *
 * The one thing to keep in mind when changing this file: `verifyUser` is a UI
 * affordance and `submitAttendance` is the enforcement point. Nothing forces a
 * client to call the first — a direct `POST` is trivially constructed — so the
 * write path re-runs every check itself. Golden Rule 3 cannot be satisfied by a
 * browser.
 */

/** One server a handle is a current member of, and its state for today. */
export type TMemberServer = {
  guildId: string;
  label: string;
  alreadySubmitted: boolean;
};

/** What the form is told about a handle it asked about. */
type TVerificationResult = {
  verified: boolean;
  /**
   * True only when EVERY server the handle belongs to already holds today's
   * row. A member of two servers who submitted in one still has something to
   * do, so presenting them as finished would leave them missing in the other.
   */
  alreadySubmitted: boolean;
  /** Today's Dhaka date, so the form can name it in its own messages. */
  attendanceDate: string;
  member: VerifiedMember | null;
  /** Every configured server this handle is currently a member of. */
  servers: TMemberServer[];
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
 * The message an address that is not on the roster gets.
 *
 * Says only that the address was not recognized. No name, no phone number, no
 * suggested spelling, no count of who is enrolled — and, critically, the SAME
 * message whether the address was never on the roll or was removed from it.
 * Distinguishing those two would let anyone who can type an address confirm
 * that a particular person used to be enrolled, which is the same disclosure
 * `findActiveMembersByUsername` collapses for departed members.
 */
const NOT_ENROLLED_MESSAGE =
  'This email address is not on our enrolled student list. Please use the email address you enrolled with, or contact an admin.';

/**
 * The roster gate: does this email address belong to an enrolled person?
 *
 * Reads the stored setting FIRST, and when enforcement is off returns without
 * touching the roster at all — so a deployment that has not armed the feature
 * pays one primary-key lookup and behaves exactly as it did before the roster
 * existed.
 *
 * There is deliberately no "the roster is empty, so let everyone through"
 * branch here. A gate that disarms itself under a condition nobody is watching
 * is a gate nobody can reason about; the guard against arming an empty roster
 * lives on `PATCH /api/roster/settings`, where a human reads the refusal.
 *
 * One indexed read on a unique column. No Discord call, and no dependence on
 * how many servers the handle belongs to.
 */
const assertEnrolled = async (rawEmail: string): Promise<void> => {
  const settings = await rosterRepository.getOrCreateSettings();

  if (!settings.enforceEmail) return;

  const entry = await rosterRepository.findActiveEntryByEmail(
    normalizeRosterEmail(rawEmail),
  );

  if (!entry) {
    throw new AppError(httpStatus.FORBIDDEN, NOT_ENROLLED_MESSAGE);
  }
};

/**
 * Resolves a raw form input to every configured server the handle is currently
 * a member of. Empty when it belongs to none.
 *
 * Both endpoints go through here so there is exactly one definition of
 * "verified". If the verify endpoint and the submit endpoint ever disagreed
 * about what counts as a member, the form would show a ✅ badge on a handle that
 * cannot submit.
 *
 * Returns every match rather than the first, because a Discord handle names one
 * ACCOUNT: several rows are that one person present in several servers, and
 * picking one arbitrarily would record their attendance in a server they did
 * not mean and leave them missing in the other.
 *
 * The repository already collapses "no such row" and "row exists but the member
 * left" into an empty result, and this layer keeps them collapsed: both produce
 * the same outcome, and telling them apart would let anyone confirm that a
 * specific person used to be in a server.
 */
const resolveActiveMembers = async (
  rawUsername: string,
): Promise<VerifiedMember[]> => {
  const normalized = normalizeDiscordUsername(rawUsername);

  return memberRepository.findActiveMembersByUsername(normalized);
};

/** The display name for a server a member belongs to. */
const labelFor = (guildId: string): string => {
  const config = getGuildConfig(guildId);

  return config ? guildLabel(config) : guildId;
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
 *
 * Takes NO email parameter, deliberately, and must not gain one. This endpoint
 * carries a 60/min per-IP budget on a process-local store; `submit` carries
 * 5/15min. Accepting an address here would turn it into a roster oracle
 * answering ~86,000 queries a day per IP — enumeration of the enrolment roll of
 * every student in the program. Behind the submit budget the same oracle costs
 * 480 a day and every probe is a logged write attempt. The roster is contact
 * data for thousands of people; it does not belong behind the cheap read
 * budget. The form is told UP FRONT that an enrolled address is required
 * through `emailVerificationRequired` on `GET /api/attendance/window`, which
 * exposes a boolean and nothing else.
 */
const verifyUser = async (
  rawUsername: string,
): Promise<TVerificationResult> => {
  // Resolved once and threaded through. A second call could land on the next
  // day at 23:59:59.9 and report a date that disagrees with the lookup below.
  const attendanceDate = getDhakaDate();

  const members = await resolveActiveMembers(rawUsername);

  if (members.length === 0) {
    return {
      verified: false,
      alreadySubmitted: false,
      attendanceDate,
      member: null,
      servers: [],
    };
  }

  const existing = await attendanceRepository.findAttendanceForMembersOnDate(
    members.map((member) => member.id),
    attendanceDate,
  );
  const submittedMemberIds = new Set(existing.map((row) => row.memberId));

  const servers: TMemberServer[] = members.map((member) => ({
    guildId: member.guildId,
    label: labelFor(member.guildId),
    alreadySubmitted: submittedMemberIds.has(member.id),
  }));

  return {
    verified: true,
    // Only "done" when every server they belong to already has today's row.
    // Reporting true because ONE server has it would tell a member of two
    // servers there is nothing left to do, and leave them counted as missing
    // in the other.
    alreadySubmitted: servers.every((server) => server.alreadySubmitted),
    attendanceDate,
    // The profile is the account's, so any of the rows carries it; the first is
    // deterministic because the repository orders by server.
    member: members[0] ?? null,
    servers,
  };
};

/**
 * Records today's attendance in EVERY configured server the handle belongs to.
 *
 * Re-verifies membership regardless of any earlier `verifyUser` call: the two
 * requests are separated by however long the student takes to fill the form, and
 * `guildMemberRemove` fires in between often enough to matter in a 5,000-member
 * server. The set resolved here — not the one verify saw — is what gets written.
 *
 * One submission covers the person everywhere they are a member. The alternative
 * (make the student pick a server) would have to list their servers before they
 * are authenticated in any sense, leaking membership to anyone who can type a
 * handle — and would reintroduce the failure this design exists to remove: being
 * marked missing in server B because they picked server A.
 *
 * The existence read below is NOT the duplicate check. The unique constraint
 * still decides that, and two simultaneous submissions still resolve to one row
 * per server (Golden Rule 7). This read only decides which servers still need a
 * row, so a student who joined a second server after submitting gets the missing
 * one written instead of being refused outright.
 */
const submitAttendance = async (payload: TSubmitAttendancePayload) => {
  const attendanceDate = getDhakaDate();

  // The roster gate runs BEFORE membership resolution. It is one indexed read
  // against a local table, where resolution is a `findMany` followed — on
  // success — by an existence read and a transactional multi-row write, so
  // refusing on the cheaper check does less work per rejected request on the
  // one endpoint an unauthenticated stranger can reach. It also keeps the
  // messages unambiguous: a request failing both checks is told about the
  // email, and once that is corrected is told about the handle, rather than the
  // two competing to explain the refusal.
  //
  // The two checks are INDEPENDENT by design. The roster knows nothing about
  // Discord, and this does not require the matched entry to describe the same
  // person as the account. What is asserted is that an enrolled person's
  // address was supplied AND that the submitting account is in a configured
  // server. See the header of `prisma/schema/roster.prisma`.
  await assertEnrolled(payload.email);

  const members = await resolveActiveMembers(payload.discordUsername);

  if (members.length === 0) {
    throw new AppError(httpStatus.NOT_FOUND, NOT_A_MEMBER_MESSAGE);
  }

  const existing = await attendanceRepository.findAttendanceForMembersOnDate(
    members.map((member) => member.id),
    attendanceDate,
  );
  const submittedMemberIds = new Set(existing.map((row) => row.memberId));
  const pending = members.filter(
    (member) => !submittedMemberIds.has(member.id),
  );

  // Every server they belong to already has today's row: that is the duplicate.
  if (pending.length === 0) {
    throw new AppError(
      httpStatus.CONFLICT,
      `You have already submitted your attendance for today (${attendanceDate}).`,
    );
  }

  try {
    const created = await attendanceRepository.createAttendanceForMembers(
      pending.map((member) => ({
        memberId: member.id,
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
        attendanceDate,
      })),
    );

    return {
      attendanceDate,
      submittedAt: created[0]?.submittedAt ?? new Date(),
      member: members[0] ?? null,
      // Named so the form can tell a member of two servers that both were
      // recorded, and so a partial top-up reads as the success it is.
      servers: members.map((member) => ({
        guildId: member.guildId,
        label: labelFor(member.guildId),
        recorded: pending.some((candidate) => candidate.id === member.id),
        alreadySubmitted: submittedMemberIds.has(member.id),
      })),
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
  /**
   * Whether the email entered on the form must be one on the enrolled student
   * list. A bare boolean and nothing else about the roster — no count, no
   * address, no editor identity — on the one route reachable without a token.
   */
  emailVerificationRequired: boolean;
};

/**
 * Projection of the current attendance submission window for the public form.
 *
 * Sourced entirely from the `channel_schedules` row and the Dhaka clock.
 * Deliberately performs no external I/O (no Discord API calls) so high student
 * traffic cannot exhaust Discord rate limits or degrade member sync.
 */
const getAttendanceWindow = async (): Promise<TAttendanceWindowResult> => {
  // Read together: both are single-row lookups of stored configuration, and the
  // roster flag comes from the SAME row the submit gate reads, so the form can
  // never advertise a requirement different from the one actually enforced.
  const [schedule, rosterSettings] = await Promise.all([
    channelScheduleRepository.getOrCreateSchedule(),
    rosterRepository.getOrCreateSettings(),
  ]);
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
  // `TChannelScheduleWithEditor` carrying `updatedBy` (admin name and email),
  // and `getOrCreateSettings()` returns the same shape for the roster row.
  // A spread-and-omit would expose any field later added to either row or
  // include, on the one route reachable without a token. Only the boolean
  // crosses from the roster settings — never the editor, never a count.
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
    emailVerificationRequired: rosterSettings.enforceEmail,
  };
};

export const attendanceService = {
  verifyUser,
  submitAttendance,
  getAttendanceWindow,
};
