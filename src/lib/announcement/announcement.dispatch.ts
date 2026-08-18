import { Prisma } from '@generated/prisma/client';
import type { AnnouncementTrigger } from '@generated/prisma/enums';

import config from '@/config';
import {
  getAttendanceChannelId,
  postAttendanceAnnouncement,
  resolveMentionTargets,
} from '@/lib/discord/announcement';
import { getDiscordConfig, isDiscordConnected } from '@/lib/discord/client';
import { announcementRepository } from '@/repositories/announcement.repository';
import { channelScheduleRepository } from '@/repositories/channelSchedule.repository';
import {
  buildMentionLine,
  composeAnnouncement,
  renderAnnouncement,
} from '@/utils/announcementTemplate';
import { getDhakaDate } from '@/utils/dhakaDate';
import { createLogger } from '@/utils/logger';

const logger = createLogger('AnnouncementDispatch');

/**
 * The sequence behind one announcement: read the template, render it against
 * live values, resolve the mention allowlist, claim the day, post, record.
 *
 * It sits between the cron task and Discord because both of its callers need
 * the same sequence and neither can host it. The cron callback has no request to
 * fail, so this function never throws — every path returns a result value. The
 * other caller, `announcement.service.ts`, turns a returned failure into an
 * `AppError`, and is the only place in this feature that raises one.
 *
 * ── Why the claim comes before the send ───────────────────────────────────
 * Recording after a successful post leaves a window where a crash between the
 * two lets the next run post a duplicate. Claiming first inverts that risk into
 * "claimed but never posted", which shows up as a `SENDING` row in the status
 * endpoint and is recoverable with a forced manual send. A duplicate
 * mass-mention in a channel the whole program reads is not recoverable at all.
 */

export type TDispatchInput = {
  trigger: AnnouncementTrigger;
  /** Post a deliberate second message today, as the next attempt. */
  force?: boolean;
  /** The admin behind a MANUAL send; absent for a SCHEDULED one. */
  triggeredById?: string | null;
};

export type TDispatchResult =
  | {
      status: 'posted';
      announcementDate: string;
      attempt: number;
      messageId: string;
      unresolvedTargets: string[];
    }
  /** Today is already claimed by a POSTED or in-flight SENDING attempt. */
  | {
      status: 'already-sent';
      announcementDate: string;
      attempt: number;
      postedAt: Date;
    }
  /** The schedule is off and this was a timed run. Not a failure. */
  | { status: 'disabled' }
  | {
      status: 'failed';
      announcementDate: string;
      error: string;
      missingPermission: boolean;
      /** Discord was never reachable, so nothing was attempted. */
      notConnected: boolean;
    };

/**
 * The most recent dispatch, in memory.
 *
 * Kept alongside the durable log for the same reason `lastRun` is kept in the
 * channel scheduler: what matters operationally is that the latest failure is
 * visible somewhere other than the logs, including the failures that happen
 * before a row exists to write it to — an unreachable database, a bot that never
 * connected.
 */
export type TLastAnnouncementOutcome = {
  ranAt: Date;
  trigger: AnnouncementTrigger;
  result: TDispatchResult;
};

let lastOutcome: TLastAnnouncementOutcome | null = null;

export const getLastAnnouncementOutcome = (): TLastAnnouncementOutcome | null =>
  lastOutcome;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const record = (
  trigger: AnnouncementTrigger,
  result: TDispatchResult,
): TDispatchResult => {
  lastOutcome = { ranAt: new Date(), trigger, result };

  return result;
};

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/**
 * Everything the body can refer to, gathered from its live source.
 *
 * `closeTime` is read from the daily-update schedule rather than stored twice —
 * a second copy is exactly the drift this feature exists to remove. The date is
 * the Dhaka civil date, never a slice of an ISO string.
 */
const buildContext = async (terminationDay: number) => {
  const schedule = await channelScheduleRepository.getOrCreateSchedule();

  return {
    date: getDhakaDate(),
    closeTime: schedule.closeTime,
    dailyUpdateChannelId: getDiscordConfig()?.channels.dailyUpdate ?? '',
    attendanceFormLink: config.attendance_form_url ?? '',
    terminationDay,
  };
};

/**
 * Whichever attempt row this run is allowed to write into, or a reason it is
 * not allowed to write into any.
 *
 * The three outcomes correspond to the three states a day can be in: unclaimed
 * (insert wins), claimed and terminal-or-in-flight (back off), or claimed and
 * failed (re-take it, because a failed send must not consume the day).
 */
type TClaimOutcome =
  | { kind: 'claimed'; logId: string; attempt: number }
  | { kind: 'taken'; attempt: number; postedAt: Date }
  | { kind: 'error'; error: string };

const claim = async ({
  announcementDate,
  attempt,
  trigger,
  renderedMessage,
  triggeredById,
  allowReclaim,
}: {
  announcementDate: string;
  attempt: number;
  trigger: AnnouncementTrigger;
  renderedMessage: string;
  triggeredById?: string | null;
  allowReclaim: boolean;
}): Promise<TClaimOutcome> => {
  try {
    const log = await announcementRepository.claimDay({
      announcementDate,
      attempt,
      trigger,
      renderedMessage,
      triggeredById,
    });

    return { kind: 'claimed', logId: log.id, attempt };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      return { kind: 'error', error: describeError(error) };
    }
  }

  // Somebody else holds this attempt. Which of them, and whether this run may
  // take it back, depends on where they got to.
  const existing = await announcementRepository.findAttempt(
    announcementDate,
    attempt,
  );

  if (!existing) {
    // The row vanished between the failed insert and this read — only possible
    // if it was deleted by hand. Treat it as taken rather than looping.
    return { kind: 'error', error: 'The claim for today could not be read.' };
  }

  if (!allowReclaim || existing.status !== 'FAILED') {
    return {
      kind: 'taken',
      attempt: existing.attempt,
      postedAt: existing.updatedAt,
    };
  }

  const reclaimed = await announcementRepository.reclaimFailedDay({
    announcementDate,
    attempt,
    trigger,
    renderedMessage,
    triggeredById,
  });

  // Zero rows means another caller re-took it first, between the read above and
  // this update. Backing off is the whole point of the scoped update.
  if (reclaimed === 0) {
    return {
      kind: 'taken',
      attempt: existing.attempt,
      postedAt: existing.updatedAt,
    };
  }

  return { kind: 'claimed', logId: existing.id, attempt };
};

/**
 * Renders, claims, posts, and records one announcement.
 *
 * Never throws. Every failure — a template that cannot be read, a bot that is
 * not connected, a channel that refuses the message — comes back as a
 * `TDispatchResult` and is stored as `lastOutcome`.
 */
export const dispatchAttendanceAnnouncement = async ({
  trigger,
  force = false,
  triggeredById = null,
}: TDispatchInput): Promise<TDispatchResult> => {
  const announcementDate = getDhakaDate();

  try {
    const template = await announcementRepository.getOrCreateTemplate();

    // A disabled schedule stops the timed post and nothing else. A manual send
    // is an admin acting deliberately, and must still work — that is what makes
    // `enabled: false` a pause rather than a lockout.
    if (!template.enabled && trigger === 'SCHEDULED') {
      logger.info(
        'Announcement schedule is disabled; skipping the timed post. Manual sends still work.',
      );
      return record(trigger, { status: 'disabled' });
    }

    // Checked before the claim so a disconnected bot does not burn the day on a
    // send that was never going to reach Discord.
    if (!isDiscordConnected()) {
      logger.error(
        'Skipping the announcement: the Discord bot is not connected.',
      );

      return record(trigger, {
        status: 'failed',
        announcementDate,
        error: 'Discord bot is not connected',
        missingPermission: false,
        notConnected: true,
      });
    }

    const context = await buildContext(template.terminationDays);
    const renderedBody = renderAnnouncement(template.body, context);

    const mentions = await resolveMentionTargets({
      roleIds: template.mentionRoleIds,
      usernames: template.mentionUsernames,
    });

    const content = composeAnnouncement(
      renderedBody,
      buildMentionLine({
        everyone: template.mentionEveryone,
        roleIds: mentions.roleIds,
        userIds: mentions.userIds,
      }),
    );

    // A forced send takes the next attempt number rather than re-taking today's
    // first one, so a deliberate second post is expressible without weakening
    // the constraint that stops an accidental one. A P2002 on that number is a
    // conflict to report, never something to retry into.
    const attempt = force
      ? await announcementRepository.nextAttemptNumber(announcementDate)
      : 1;

    const claimed = await claim({
      announcementDate,
      attempt,
      trigger,
      renderedMessage: content,
      triggeredById,
      allowReclaim: !force,
    });

    if (claimed.kind === 'error') {
      return record(trigger, {
        status: 'failed',
        announcementDate,
        error: claimed.error,
        missingPermission: false,
        notConnected: false,
      });
    }

    if (claimed.kind === 'taken') {
      logger.info(
        `Announcement for ${announcementDate} is already claimed (attempt ${claimed.attempt}); nothing posted.`,
      );

      return record(trigger, {
        status: 'already-sent',
        announcementDate,
        attempt: claimed.attempt,
        postedAt: claimed.postedAt,
      });
    }

    const posted = await postAttendanceAnnouncement({
      content,
      mentions: {
        everyone: template.mentionEveryone,
        roleIds: mentions.roleIds,
        userIds: mentions.userIds,
      },
      // Derived from the claim, not from the clock, so every HTTP attempt at
      // delivering this one announcement carries the same value and Discord
      // can collapse them. `YYYY-MM-DD` + attempt is 12-14 characters, inside
      // the 25-character limit. See `postAttendanceAnnouncement`.
      nonce: `${announcementDate}-${claimed.attempt}`,
    });

    if (!posted.ok) {
      // Recorded as FAILED, which is exactly what lets a later attempt today
      // re-take the day through `reclaimFailedDay`.
      await announcementRepository.markFailed(claimed.logId, posted.error);

      return record(trigger, {
        status: 'failed',
        announcementDate,
        error: posted.error,
        missingPermission: posted.missingPermission,
        notConnected: false,
      });
    }

    await announcementRepository.markPosted({
      id: claimed.logId,
      discordMessageId: posted.messageId,
      mentionedRoleIds: mentions.roleIds,
      mentionedUserIds: mentions.userIds,
      unresolvedTargets: mentions.unresolved,
    });

    logger.info(
      `Announcement for ${announcementDate} posted to channel ${getAttendanceChannelId() ?? 'unknown'} (attempt ${claimed.attempt}).`,
    );

    return record(trigger, {
      status: 'posted',
      announcementDate,
      attempt: claimed.attempt,
      messageId: posted.messageId,
      unresolvedTargets: mentions.unresolved,
    });
  } catch (error) {
    // The outer net. A cron callback has nothing to catch a throw, and an
    // unhandled rejection here would take the process down with it.
    logger.error('Announcement dispatch failed:', describeError(error));

    return record(trigger, {
      status: 'failed',
      announcementDate,
      error: describeError(error),
      missingPermission: false,
      notConnected: false,
    });
  }
};
