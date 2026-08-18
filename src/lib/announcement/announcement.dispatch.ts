import { Prisma } from '@generated/prisma/client';
import type { AnnouncementTrigger } from '@generated/prisma/enums';

import config from '@/config';
import type { TGuildConfig } from '@/config/discord';
import {
  getAttendanceChannelId,
  postAttendanceAnnouncement,
  resolveMentionTargets,
} from '@/lib/discord/announcement';
import {
  getGuildsWithVerifiedChannel,
  isDiscordConnected,
} from '@/lib/discord/client';
import { guildLabel } from '@/lib/discord/fanout';
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

/**
 * Keyed per server, for the same reason the scheduler's `lastRun` is: a missing
 * `Send Messages` in one server is the case worth seeing, and a single slot
 * would let the healthy server's success overwrite it.
 */
const lastOutcomes = new Map<string, TLastAnnouncementOutcome>();

export const getLastAnnouncementOutcome = (
  guildId: string,
): TLastAnnouncementOutcome | null => lastOutcomes.get(guildId) ?? null;

export const getLastAnnouncementOutcomes = (): Record<
  string,
  TLastAnnouncementOutcome
> => Object.fromEntries(lastOutcomes.entries());

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const record = (
  guildId: string,
  trigger: AnnouncementTrigger,
  result: TDispatchResult,
): TDispatchResult => {
  lastOutcomes.set(guildId, { ranAt: new Date(), trigger, result });

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
const buildContext = async (guild: TGuildConfig, terminationDay: number) => {
  const schedule = await channelScheduleRepository.getOrCreateSchedule();

  return {
    date: getDhakaDate(),
    closeTime: schedule.closeTime,
    // THIS server's channel. A `<#id>` link to the other server's channel would
    // render as a dead reference for everyone reading it here.
    dailyUpdateChannelId: guild.channels.dailyUpdate,
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
  guildId,
  announcementDate,
  attempt,
  trigger,
  renderedMessage,
  triggeredById,
  allowReclaim,
}: {
  guildId: string;
  announcementDate: string;
  attempt: number;
  trigger: AnnouncementTrigger;
  renderedMessage: string;
  triggeredById?: string | null;
  allowReclaim: boolean;
}): Promise<TClaimOutcome> => {
  try {
    const log = await announcementRepository.claimDay({
      guildId,
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
    guildId,
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
    guildId,
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
/**
 * The servers an announcement run targets: those whose attendance channel
 * passed ownership verification, optionally narrowed to named ones.
 *
 * A server whose channel resolves into a different guild is excluded rather
 * than posted to — posting there would put this server's message in front of
 * the other server's students while the log recorded a success.
 */
const targetGuilds = (guildIds?: string[]): TGuildConfig[] => {
  const verified = getGuildsWithVerifiedChannel('attendance');

  if (!guildIds?.length) return verified;

  return verified.filter((guild) => guildIds.includes(guild.guildId));
};

const dispatchForGuild = async (
  guild: TGuildConfig,
  template: Awaited<ReturnType<typeof announcementRepository.getOrCreateTemplate>>,
  { trigger, force, triggeredById }: Required<TDispatchInput>,
): Promise<TDispatchResult> => {
  const announcementDate = getDhakaDate();
  const guildId = guild.guildId;

  try {
    const context = await buildContext(guild, template.terminationDays);
    const renderedBody = renderAnnouncement(template.body, context);

    // Resolved separately inside each server. A role ID exists in one guild
    // only, and a handle may belong to one server and not the other — an entry
    // that does not resolve HERE is dropped from THIS post and recorded, never
    // a reason to withhold the message from the students who are waiting for it.
    const mentions = await resolveMentionTargets(guild, {
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
      ? await announcementRepository.nextAttemptNumber(guildId, announcementDate)
      : 1;

    const claimed = await claim({
      guildId,
      announcementDate,
      attempt,
      trigger,
      renderedMessage: content,
      triggeredById,
      allowReclaim: !force,
    });

    if (claimed.kind === 'error') {
      return record(guildId, trigger, {
        status: 'failed',
        announcementDate,
        error: claimed.error,
        missingPermission: false,
        notConnected: false,
      });
    }

    if (claimed.kind === 'taken') {
      logger.info(
        `Announcement for ${announcementDate} in guild ${guildId} is already claimed (attempt ${claimed.attempt}); nothing posted.`,
      );

      return record(guildId, trigger, {
        status: 'already-sent',
        announcementDate,
        attempt: claimed.attempt,
        postedAt: claimed.postedAt,
      });
    }

    const posted = await postAttendanceAnnouncement(guild, {
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
      nonce: `${guildId}-${announcementDate}-${claimed.attempt}`,
    });

    if (!posted.ok) {
      // Recorded as FAILED, which is exactly what lets a later attempt today
      // re-take the day through `reclaimFailedDay`.
      await announcementRepository.markFailed(claimed.logId, posted.error);

      return record(guildId, trigger, {
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
      `Announcement for ${announcementDate} posted to channel ${getAttendanceChannelId(guild)} in guild ${guildId} (attempt ${claimed.attempt}).`,
    );

    return record(guildId, trigger, {
      status: 'posted',
      announcementDate,
      attempt: claimed.attempt,
      messageId: posted.messageId,
      unresolvedTargets: mentions.unresolved,
    });
  } catch (error) {
    // The outer net. A cron callback has nothing to catch a throw, and an
    // unhandled rejection here would take the process down with it.
    logger.error(
      `Announcement dispatch failed for guild ${guildId}:`,
      describeError(error),
    );

    return record(guildId, trigger, {
      status: 'failed',
      announcementDate,
      error: describeError(error),
      missingPermission: false,
      notConnected: false,
    });
  }
};


export type TGuildDispatchOutcome = {
  guildId: string;
  label: string;
  result: TDispatchResult;
};

/**
 * Renders, claims, posts, and records the announcement in EVERY configured
 * server (or only those named).
 *
 * ONE template, ONE schedule, ONE mention allowlist — fanned out. Each server
 * takes its OWN once-per-day claim, so a failure in one neither blocks nor is
 * hidden by a success in the other, and a retry re-posts only where it failed.
 *
 * Never throws. Every failure comes back as that server's `TDispatchResult`.
 */
export const dispatchAttendanceAnnouncement = async ({
  trigger,
  force = false,
  triggeredById = null,
  guildIds,
}: TDispatchInput & { guildIds?: string[] }): Promise<
  TGuildDispatchOutcome[]
> => {
  const announcementDate = getDhakaDate();

  let template: Awaited<
    ReturnType<typeof announcementRepository.getOrCreateTemplate>
  >;

  try {
    template = await announcementRepository.getOrCreateTemplate();
  } catch (error) {
    logger.error('Could not read the announcement template:', describeError(error));

    // No template means nothing to post anywhere; reported against every
    // targeted server so the failure is visible on the status read.
    return targetGuilds(guildIds).map((guild) => ({
      guildId: guild.guildId,
      label: guildLabel(guild),
      result: record(guild.guildId, trigger, {
        status: 'failed' as const,
        announcementDate,
        error: describeError(error),
        missingPermission: false,
        notConnected: false,
      }),
    }));
  }

  // A disabled schedule stops the timed post and nothing else. A manual send is
  // an admin acting deliberately, and must still work — that is what makes
  // `enabled: false` a pause rather than a lockout.
  if (!template.enabled && trigger === 'SCHEDULED') {
    logger.info(
      'Announcement schedule is disabled; skipping the timed post. Manual sends still work.',
    );

    return targetGuilds(guildIds).map((guild) => ({
      guildId: guild.guildId,
      label: guildLabel(guild),
      result: record(guild.guildId, trigger, { status: 'disabled' as const }),
    }));
  }

  // Checked once, before any claim: a disconnected bot must not burn any
  // server's day on a send that was never going to reach Discord.
  if (!isDiscordConnected()) {
    logger.error('Skipping the announcement: the Discord bot is not connected.');

    return targetGuilds(guildIds).map((guild) => ({
      guildId: guild.guildId,
      label: guildLabel(guild),
      result: record(guild.guildId, trigger, {
        status: 'failed' as const,
        announcementDate,
        error: 'Discord bot is not connected',
        missingPermission: false,
        notConnected: true,
      }),
    }));
  }

  const outcomes: TGuildDispatchOutcome[] = [];

  // Sequential, and each server contained: fan-out must not multiply the
  // instantaneous Discord burst, and one server's refusal must not stop the
  // next server's students from getting their message.
  for (const guild of targetGuilds(guildIds)) {
    outcomes.push({
      guildId: guild.guildId,
      label: guildLabel(guild),
      result: await dispatchForGuild(guild, template, {
        trigger,
        force,
        triggeredById,
      }),
    });
  }

  return outcomes;
};
