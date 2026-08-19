import httpStatus from 'http-status';

import config from '@/config';
import type { TGuildConfig } from '@/config/discord';
import AppError from '@/errors/AppError';
import {
  dispatchAttendanceAnnouncement,
  getLastAnnouncementOutcome,
} from '@/lib/announcement/announcement.dispatch';
import {
  getAttendanceChannelId,
  resolveMentionTargets,
} from '@/lib/discord/announcement';
import { getConfiguredGuilds } from '@/lib/discord/client';
import { guildLabel } from '@/lib/discord/fanout';
import {
  getAnnouncementSchedulerState,
  reloadAnnouncementSchedule,
} from '@/lib/scheduler/announcement.scheduler';
import {
  openChannelsForAnnouncement,
  reloadChannelSchedule,
} from '@/lib/scheduler/channelSchedule.scheduler';
import {
  announcementRepository,
  type TAnnouncementTemplateWithEditor,
} from '@/repositories/announcement.repository';
import { channelScheduleRepository } from '@/repositories/channelSchedule.repository';
import {
  ANNOUNCEMENT_PLACEHOLDERS,
  buildMentionLine,
  composeAnnouncement,
  DISCORD_MESSAGE_LIMIT,
  findUnsupportedPlaceholders,
  renderAnnouncement,
} from '@/utils/announcementTemplate';
import { DHAKA_TIMEZONE, getDhakaDate } from '@/utils/dhakaDate';
import { normalizeDiscordUsername } from '@/utils/discordUsername';
import { createLogger } from '@/utils/logger';

const logger = createLogger('AnnouncementService');

/**
 * Business rules for the attendance announcement, and the only place in this
 * feature that raises an `AppError`.
 *
 * Everything below it — the repository, the renderer, the Discord module, the
 * dispatcher — returns values, because their other callers are a cron task and
 * a gateway-adjacent module with no request to fail. This file is where a
 * returned failure becomes a status code.
 */

type TUpdateAnnouncementPayload = {
  body?: string;
  terminationDays?: number;
  mentionEveryone?: boolean;
  mentionRoleIds?: string[];
  mentionUsernames?: string[];
  announceTime?: string;
  daysOfWeek?: number[];
  enabled?: boolean;
};

/** Which fields, if changed, mean the cron task has to be rebuilt. */
const SCHEDULE_FIELDS = ['announceTime', 'daysOfWeek', 'enabled'] as const;

/**
 * Renders a template against today's live values.
 *
 * Shared by the read, the preview, and the save check so all three see exactly
 * what the 7 PM post will produce. It resolves the mention allowlist too,
 * because the mention line counts toward Discord's length limit.
 */
const renderForToday = async (
  template: Pick<
    TAnnouncementTemplateWithEditor,
    | 'body'
    | 'terminationDays'
    | 'mentionEveryone'
    | 'mentionRoleIds'
    | 'mentionUsernames'
  >,
  /**
   * The server to preview for. Mentions and the `<#channel>` link resolve per
   * server, so a preview has to name one; the first configured server is the
   * default because a preview is a sanity check on the text, not a promise
   * about every server's mention resolution. Each server's ACTUAL resolution is
   * recorded on its own send log.
   */
  guild: TGuildConfig | null = getConfiguredGuilds()[0] ?? null,
) => {
  const schedule = await channelScheduleRepository.getOrCreateSchedule();

  const mentions = guild
    ? await resolveMentionTargets(guild, {
        roleIds: template.mentionRoleIds,
        usernames: template.mentionUsernames,
      })
    : { roleIds: [], userIds: [], unresolved: [] };

  const renderedBody = renderAnnouncement(template.body, {
    date: getDhakaDate(),
    // Read from the daily-update schedule rather than stored a second time.
    // A second copy of the closing time is precisely the drift this feature
    // exists to remove.
    closeTime: schedule.closeTime,
    dailyUpdateChannelId: guild?.channels.dailyUpdate ?? '',
    attendanceFormLink: config.attendance_form_url ?? '',
    terminationDay: template.terminationDays,
  });

  const mentionLine = buildMentionLine({
    everyone: template.mentionEveryone,
    roleIds: mentions.roleIds,
    userIds: mentions.userIds,
  });

  return {
    content: composeAnnouncement(renderedBody, mentionLine),
    mentions,
    closeTime: schedule.closeTime,
  };
};

/** Today's attempts, so the dashboard can say whether the message went out. */
const buildTodaySummary = async () => {
  const announcementDate = getDhakaDate();
  const logs = await announcementRepository.findLogsForDate(announcementDate);

  // Reported per server. A single `posted` flag would read as "done" the moment
  // ONE server succeeded, hiding the server that is still silent — which is the
  // only thing on this payload worth acting on.
  const servers = getConfiguredGuilds().map((guild) => {
    const guildLogs = logs.filter((log) => log.guildId === guild.guildId);

    return {
      guildId: guild.guildId,
      label: guildLabel(guild),
      channelId: getAttendanceChannelId(guild),
      posted: guildLogs.some((log) => log.status === 'POSTED'),
      lastOutcome: getLastAnnouncementOutcome(guild.guildId),
      attempts: guildLogs.map((log) => ({
        attempt: log.attempt,
        status: log.status,
        trigger: log.trigger,
        discordMessageId: log.discordMessageId,
        unresolvedTargets: log.unresolvedTargets,
        error: log.error,
        createdAt: log.createdAt,
        updatedAt: log.updatedAt,
      })),
    };
  });

  return {
    date: announcementDate,
    /** True only when EVERY configured server has today's message. */
    posted: servers.length > 0 && servers.every((server) => server.posted),
    servers,
  };
};

/** The stored row plus everything the dashboard needs around it. */
const buildAnnouncementResponse = async (
  template: TAnnouncementTemplateWithEditor,
) => {
  const rendered = await renderForToday(template);

  return {
    template: {
      body: template.body,
      terminationDays: template.terminationDays,
      mentionEveryone: template.mentionEveryone,
      mentionRoleIds: template.mentionRoleIds,
      mentionUsernames: template.mentionUsernames,
      updatedAt: template.updatedAt,
      updatedBy: template.updatedBy,
    },
    schedule: {
      announceTime: template.announceTime,
      daysOfWeek: template.daysOfWeek,
      enabled: template.enabled,
      // Reported, never accepted — the same rule as the channel schedule.
      timezone: DHAKA_TIMEZONE,
    },
    preview: {
      content: rendered.content,
      length: rendered.content.length,
      limit: DISCORD_MESSAGE_LIMIT,
      closeTime: rendered.closeTime,
      mentions: rendered.mentions,
    },
    supportedPlaceholders: ANNOUNCEMENT_PLACEHOLDERS.map(
      (name) => `{{${name}}}`,
    ),
    scheduler: getAnnouncementSchedulerState(),
    today: await buildTodaySummary(),
  };
};

const getAnnouncement = async () =>
  buildAnnouncementResponse(await announcementRepository.getOrCreateTemplate());

/**
 * Rejects a body using a placeholder that does not exist.
 *
 * Raised here rather than in the Zod schema so the token names survive
 * verbatim — `handleZodValidationError` title-cases every word of a validation
 * message, and this one exists to tell an admin the exact string to type.
 *
 * Left in the text, an unknown placeholder reaches ~5,000 students as a literal
 * `{{attendance_link}}` in the middle of the evening announcement: a visible
 * failure the save could have prevented.
 */
const assertSupportedPlaceholders = (body: string): void => {
  const unsupported = findUnsupportedPlaceholders(body);

  if (unsupported.length === 0) return;

  throw new AppError(
    httpStatus.BAD_REQUEST,
    `Unknown placeholder(s): ${unsupported.map((token) => `{{${token}}}`).join(', ')}. ` +
      `Supported placeholders are ${ANNOUNCEMENT_PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}.`,
  );
};

/**
 * Saves a partial change after checking the message it would produce.
 *
 * The merge is what makes the length check correct: validating only the
 * submitted fields would let a long body through against a mention list that
 * pushes the rendered result past Discord's limit, and the send would then fail
 * every evening with nothing in the request that saved it looking wrong.
 *
 * The length is measured on the *rendered* output including the mention line,
 * not the raw body, because placeholder expansion and a dozen role pings are
 * exactly what closes the gap to 2,000 characters.
 */
const updateAnnouncement = async (
  payload: TUpdateAnnouncementPayload,
  adminId: string,
) => {
  const current = await announcementRepository.getOrCreateTemplate();

  if (payload.body !== undefined) assertSupportedPlaceholders(payload.body);

  // The announce time is also the channel's open time, so a move has to be
  // legal as a window: `openTime` must stay strictly earlier than `closeTime`,
  // the same rule `schedule.service.ts` enforces on its own side. Checked
  // against the STORED close time rather than a submitted one, because this
  // endpoint cannot change it — an announcement at 23:59 against a close of
  // 23:59 would otherwise write a window that opens and locks in the same
  // minute, and one at 00:30 would cross midnight.
  if (payload.announceTime !== undefined) {
    const schedule = await channelScheduleRepository.getOrCreateSchedule();

    if (payload.announceTime >= schedule.closeTime) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `The announcement time must be earlier than the time the daily-update channel locks. ` +
          `Received ${payload.announceTime} against a close time of ${schedule.closeTime}. ` +
          `The channel opens when this announcement is posted, so an announcement at or after the ` +
          `close time would leave students no window to post in. Move the close time first at ` +
          `PATCH /api/schedule/daily-update.`,
      );
    }
  }

  // Normalized here rather than trusted from validation: `validateRequest`
  // checks `req.body` without assigning the parsed result back, so the schema's
  // transform never reaches this layer. The stored form must match what
  // `discord_members` holds, since the post-time lookup is an exact match.
  const mentionUsernames = payload.mentionUsernames?.map(
    normalizeDiscordUsername,
  );

  const merged = {
    body: payload.body ?? current.body,
    terminationDays: payload.terminationDays ?? current.terminationDays,
    mentionEveryone: payload.mentionEveryone ?? current.mentionEveryone,
    mentionRoleIds: payload.mentionRoleIds ?? current.mentionRoleIds,
    mentionUsernames: mentionUsernames ?? current.mentionUsernames,
  };

  const rendered = await renderForToday(merged);

  if (rendered.content.length > DISCORD_MESSAGE_LIMIT) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `The rendered message is ${rendered.content.length} characters, over Discord's ${DISCORD_MESSAGE_LIMIT}-character limit. ` +
        'The length is measured after placeholders are expanded and the mention line is added, so shorten the body or reduce the mention list.',
    );
  }

  const updated = await announcementRepository.updateTemplate({
    ...payload,
    ...(mentionUsernames ? { mentionUsernames } : {}),
    // One save, two rows: the channel opens when the announcement is posted.
    ...(payload.announceTime !== undefined
      ? { mirrorOpenTime: payload.announceTime }
      : {}),
    updatedById: adminId,
  });

  // The announce time drives two cron tasks now — the announcement's own, and
  // the channel's open job through the mirrored `open_time`. Reloading the
  // channel scheduler also reconciles the live channel, so moving the time to
  // one that has already passed today opens the channel immediately rather
  // than tomorrow.
  if (payload.announceTime !== undefined) {
    try {
      await reloadChannelSchedule();
    } catch (error) {
      logger.error(
        'Announcement saved but the channel scheduler could not be reloaded:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  const scheduleChanged = SCHEDULE_FIELDS.some(
    (field) => payload[field] !== undefined,
  );

  if (scheduleChanged) {
    // Deliberately not allowed to fail the request: the row is already saved,
    // and reporting a failed save would be wrong. A reload failure is logged
    // and shows up under `scheduler` on the next read.
    try {
      await reloadAnnouncementSchedule();
    } catch (error) {
      logger.error(
        'Announcement saved but the scheduler could not be reloaded:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  return buildAnnouncementResponse(updated);
};

/**
 * Renders an unsaved body against today's live values, storing nothing.
 *
 * The point of the endpoint is that an admin can read the whole message —
 * expanded date, real closing time, resolved mentions — before it reaches a
 * channel the entire program watches.
 */
const previewAnnouncement = async (payload: {
  body?: string;
  terminationDays?: number;
}) => {
  const current = await announcementRepository.getOrCreateTemplate();

  if (payload.body !== undefined) assertSupportedPlaceholders(payload.body);

  const rendered = await renderForToday({
    body: payload.body ?? current.body,
    terminationDays: payload.terminationDays ?? current.terminationDays,
    mentionEveryone: current.mentionEveryone,
    mentionRoleIds: current.mentionRoleIds,
    mentionUsernames: current.mentionUsernames,
  });

  return {
    content: rendered.content,
    length: rendered.content.length,
    limit: DISCORD_MESSAGE_LIMIT,
    withinLimit: rendered.content.length <= DISCORD_MESSAGE_LIMIT,
    closeTime: rendered.closeTime,
    mentions: rendered.mentions,
    supportedPlaceholders: ANNOUNCEMENT_PLACEHOLDERS.map(
      (name) => `{{${name}}}`,
    ),
  };
};

/**
 * Opens `#daily-update` after a manual send, and reports what happened.
 *
 * The stored schedule is deliberately NOT touched: a send at 20:30 is a moment,
 * not a new opening time, so tomorrow still opens at the announce time. That
 * matches the manual open/lock endpoints, which override the state without
 * rewriting the row.
 *
 * `locksAt` is the honest part of the answer. With the channel schedule
 * disabled there is no lock job, so a window opened here would stay open past
 * midnight and file the small hours under the following day — the admin needs
 * to know that before they walk away, not discover it in the morning.
 */
const openWindowForPostedServers = async (guildIds: string[]) => {
  const schedule = await channelScheduleRepository.getOrCreateSchedule();

  if (guildIds.length === 0) {
    return { opened: [], alreadyOpen: [], failed: [], locksAt: null };
  }

  try {
    const { outcomes, alreadyOpen } =
      await openChannelsForAnnouncement(guildIds);

    return {
      opened: outcomes.filter((o) => o.ok).map((o) => o.guildId),
      alreadyOpen,
      failed: outcomes
        .filter((o) => !o.ok)
        .map((o) => ({
          guildId: o.guildId,
          label: o.label,
          error: o.ok ? null : o.error,
        })),
      locksAt: schedule.enabled ? schedule.closeTime : null,
    };
  } catch (error) {
    // Nothing under the scheduler throws past its own boundary, so this is the
    // belt to that braces: a send that posted must never come back as a 500.
    logger.error(
      'The announcement posted but the channel could not be opened:',
      error instanceof Error ? error.message : error,
    );

    return {
      opened: [],
      alreadyOpen: [],
      failed: guildIds.map((guildId) => ({
        guildId,
        label: guildId,
        error: 'The channel open failed; see the server logs.',
      })),
      locksAt: schedule.enabled ? schedule.closeTime : null,
    };
  }
};

/**
 * Posts the announcement now, independently of the schedule.
 *
 * The escape hatch for a missed run, a process that does not run the timed
 * tasks, or a first send after deployment. It does not touch the stored
 * schedule, so the next timed post still fires normally.
 *
 * It DOES open `#daily-update` in the servers it posted to, because the message
 * tells students to submit and the window is what lets them: a send that
 * announced a window nobody could post in would be worse than no send. See
 * `openWindowForPostedServers`.
 *
 * `force` is the only way to post a second time in one day, and it is refused by
 * default: a double-clicked button must produce a 409, not a second
 * mass-mention.
 */
const sendAnnouncementNow = async (
  { force = false, guildIds }: { force?: boolean; guildIds?: string[] },
  adminId: string,
) => {
  if (guildIds?.length) {
    const known = new Set(getConfiguredGuilds().map((g) => g.guildId));
    const unknown = guildIds.filter((id) => !known.has(id));

    if (unknown.length > 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Unknown server(s): ${unknown.join(', ')}. Configured servers are listed at GET /api/discord/servers.`,
      );
    }
  }

  const outcomes = await dispatchAttendanceAnnouncement({
    trigger: 'MANUAL',
    force,
    triggeredById: adminId,
    guildIds,
  });

  if (outcomes.length === 0) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'No configured server has a verified attendance channel. Check GET /api/discord/sync/status.',
    );
  }

  const posted = outcomes.filter((o) => o.result.status === 'posted');

  // Every server already had today's message: that is the 409 a double-clicked
  // button must produce. Reported only when NONE posted — if one server posted
  // and another was already claimed, the run did real work and is a success.
  if (
    posted.length === 0 &&
    outcomes.every((o) => o.result.status === 'already-sent')
  ) {
    throw new AppError(
      httpStatus.CONFLICT,
      `Today's announcement was already sent in every targeted server. ` +
        'Send it again with { "force": true } if a second post is genuinely intended.',
    );
  }

  if (
    posted.length === 0 &&
    outcomes.every((o) => o.result.status === 'disabled')
  ) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'The announcement is disabled.',
    );
  }

  // Nothing posted anywhere and at least one hard failure: surface the reason.
  if (posted.length === 0) {
    const failure = outcomes.find((o) => o.result.status === 'failed');

    if (failure && failure.result.status === 'failed') {
      if (failure.result.missingPermission) {
        throw new AppError(
          httpStatus.FORBIDDEN,
          'The bot lacks the "Send Messages" permission on the attendance channel of every targeted server, so it cannot post the announcement. ' +
            'Grant it in the channel settings and try again — a failed attempt does not consume the day.',
        );
      }

      throw new AppError(
        httpStatus.SERVICE_UNAVAILABLE,
        failure.result.notConnected
          ? 'Discord bot is not connected. Check DISCORD_BOT_TOKEN and the bot logs.'
          : `The announcement could not be posted in any server: ${failure.result.error}`,
      );
    }
  }

  // Sending the announcement opens the window it announces, in the servers this
  // run actually posted to. Scoped to `posted` on purpose: a server whose post
  // failed was never told to submit, and one that was `already-sent` was opened
  // when that post went out — opening either here would move a window on the
  // strength of a message that server never received.
  //
  // Never allowed to fail the request. The message is already in the channel;
  // answering an error would invite a retry that cannot re-post (409) while
  // looking like the fix. A failed open is reported in `channel` and stays
  // visible on GET /api/schedule/daily-update as `lastRun.error`.
  const channel = await openWindowForPostedServers(
    posted.map((outcome) => outcome.guildId),
  );

  // Partial success is a SUCCESS carrying the per-server detail. Posting really
  // did happen somewhere, and answering an error would invite a retry that
  // re-posts nothing while looking like the fix.
  return {
    announcementDate: getDhakaDate(),
    summary: {
      total: outcomes.length,
      posted: posted.length,
      failed: outcomes.filter((o) => o.result.status === 'failed').length,
      alreadySent: outcomes.filter((o) => o.result.status === 'already-sent')
        .length,
    },
    servers: outcomes.map((outcome) => ({
      guildId: outcome.guildId,
      label: outcome.label,
      ...outcome.result,
    })),
    channel,
  };
};

export const announcementService = {
  getAnnouncement,
  updateAnnouncement,
  previewAnnouncement,
  sendAnnouncementNow,
};
