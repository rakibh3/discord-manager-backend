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
    updatedById: adminId,
  });

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
 * Posts the announcement now, independently of the schedule.
 *
 * The escape hatch for a missed run, a process that does not run the timed
 * tasks, or a first send after deployment. It does not touch the stored
 * schedule, so the next timed post still fires normally.
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
  };
};

export const announcementService = {
  getAnnouncement,
  updateAnnouncement,
  previewAnnouncement,
  sendAnnouncementNow,
};
