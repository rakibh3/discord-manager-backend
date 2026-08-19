import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import {
  getDailyUpdateChannelId,
  isDailyUpdateChannelOpen,
} from '@/lib/discord/channel.state';
import { getConfiguredGuilds, isDiscordConnected } from '@/lib/discord/client';
import { guildLabel } from '@/lib/discord/fanout';
import {
  applyChannelState,
  getLastRun,
  getSchedulableGuilds,
  getSchedulerState,
  reloadChannelSchedule,
} from '@/lib/scheduler/channelSchedule.scheduler';
import {
  channelScheduleRepository,
  type TChannelScheduleWithEditor,
} from '@/repositories/channelSchedule.repository';
import { DHAKA_TIMEZONE } from '@/utils/dhakaDate';
import { requireAnyGuildSucceeded } from '@/utils/fanoutResult';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ScheduleService');

type TUpdateSchedulePayload = {
  /**
   * Accepted by the schema only so it can be REFUSED here with an explanation.
   * Zod strips unknown keys, so dropping it from the schema would make a
   * dashboard still sending it look like it succeeded while the open time
   * silently ignored every save. See `updateSchedule`.
   */
  openTime?: string;
  closeTime?: string;
  daysOfWeek?: number[];
  enabled?: boolean;
};

/**
 * The stored row plus everything the dashboard needs around it.
 *
 * ONE schedule, reported alongside the live state of EVERY configured server's
 * channel. The schedule alone no longer describes what an administrator will
 * see: two servers can disagree about whether their channel is open, and that
 * disagreement is precisely what needs surfacing.
 */
const buildScheduleResponse = async (schedule: TChannelScheduleWithEditor) => {
  const scheduler = getSchedulerState();

  // Sequential rather than `Promise.all`: this reads one live permission per
  // server, and fan-out must not multiply the instantaneous Discord burst.
  const servers = [];

  for (const guild of getConfiguredGuilds()) {
    servers.push({
      guildId: guild.guildId,
      label: guildLabel(guild),
      channelId: getDailyUpdateChannelId(guild),
      // Read live from Discord rather than from a stored flag — an admin can
      // change the overwrite by hand at any time. `null` means it could not be
      // read, which is reported as unknown rather than assumed.
      isOpen: await isDailyUpdateChannelOpen(guild),
      lastRun: getLastRun(guild.guildId),
    });
  }

  return {
    schedule: {
      openTime: schedule.openTime,
      // Read-only here, and flagged so the dashboard renders it that way rather
      // than offering a picker whose every save is a 400. It mirrors
      // `announcement_templates.announce_time`; the channel opens when the
      // announcement telling students to submit is posted.
      openTimeSource: 'ANNOUNCEMENT',
      closeTime: schedule.closeTime,
      daysOfWeek: schedule.daysOfWeek,
      enabled: schedule.enabled,
      // Reported, never accepted. Every date in the attendance domain is a
      // Dhaka civil date, so a schedule in another zone would open the channel
      // out of step with the day its records are filed under.
      timezone: DHAKA_TIMEZONE,
      updatedAt: schedule.updatedAt,
      updatedBy: schedule.updatedBy,
    },
    scheduler,
    servers,
  };
};

const getSchedule = async () =>
  buildScheduleResponse(await channelScheduleRepository.getOrCreateSchedule());

/**
 * Saves a partial change after checking the schedule it would produce.
 *
 * The merge is what makes this correct: validating only the submitted fields
 * would let `{ closeTime: "02:00" }` through against a stored `openTime` of
 * 18:00, producing a window that crosses Dhaka midnight. A message posted at
 * 00:30 in that window gets the *following* day's `message_date`, so its author
 * reads as missing for the day they actually submitted on — a dashboard that
 * looks broken rather than misconfigured.
 */
const updateSchedule = async (
  { openTime: rejectedOpenTime, ...payload }: TUpdateSchedulePayload,
  adminId: string,
) => {
  // The open time follows the announcement time and is not editable here.
  // Refused rather than ignored: silently dropping the field would leave an
  // admin watching a time picker they moved snap back on the next read, with
  // nothing saying why. The message names the endpoint that does own it.
  if (rejectedOpenTime !== undefined) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `The open time is not set here. The daily-update channel opens when the attendance announcement ` +
      `is posted, so it follows the announcement time — change it at PATCH /api/announcement/attendance ` +
      `and this window moves with it. The close time, the weekdays and the enabled flag are still set here.`,
    );
  }

  const current = await channelScheduleRepository.getOrCreateSchedule();

  const openTime = current.openTime;
  const closeTime = payload.closeTime ?? current.closeTime;

  if (closeTime <= openTime) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `The close time must be later than the open time on the same day. ` +
      `Received close ${closeTime} against an open time of ${openTime}, which follows the announcement time; ` +
      `a window that crosses midnight is not supported, because a message posted after midnight belongs to ` +
      `the next day's attendance record. To lock earlier than the announcement, move the announcement first.`,
    );
  }

  const updated = await channelScheduleRepository.updateSchedule({
    ...payload,
    updatedById: adminId,
  });

  // Deliberately not allowed to fail the request: the row is already saved, and
  // reporting a failed save would be wrong. A reload failure is logged and
  // shows up under `scheduler` on the next read.
  try {
    await reloadChannelSchedule();
  } catch (error) {
    logger.error(
      'Schedule saved but the scheduler could not be reloaded:',
      error instanceof Error ? error.message : error,
    );
  }

  return buildScheduleResponse(updated);
};

/**
 * Forces the channel state now, independently of the schedule.
 *
 * The escape hatch for a missed run or a session that ran late. It does not
 * touch the stored schedule, so the next scheduled transition still fires
 * normally — a manual open at 2 AM does not become a new open time.
 */
const setChannelState = async (open: boolean, guildIds?: string[]) => {
  if (!isDiscordConnected()) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Discord bot is not connected. Check DISCORD_BOT_TOKEN and the bot logs.',
    );
  }

  const schedulable = getSchedulableGuilds();

  // Naming a server that is not configured is refused rather than silently
  // ignored: an admin who mistypes an ID must not be told the action succeeded
  // everywhere while it in fact ran nowhere they intended.
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

  const targets = guildIds?.length
    ? schedulable.filter((guild) => guildIds.includes(guild.guildId))
    : schedulable;

  const outcomes = await applyChannelState(targets, open, {
    trigger: 'manual',
    announce: true,
  });

  // Partial success is a SUCCESS carrying the failed server's reason. The
  // channel really did open where it worked, and answering an error would tell
  // the admin nothing happened — so they would retry, and re-announce into the
  // server that already opened.
  const envelope = requireAnyGuildSucceeded(
    outcomes,
    `The daily-update channel could not be ${open ? 'opened' : 'locked'}`,
  );

  return {
    isOpen: open,
    ...envelope,
    servers: envelope.servers.map((outcome) => ({
      ...outcome,
      channelId:
        getConfiguredGuilds().find((g) => g.guildId === outcome.guildId)
          ?.channels.dailyUpdate ?? null,
    })),
  };
};

const openChannelNow = (guildIds?: string[]) => setChannelState(true, guildIds);

const lockChannelNow = (guildIds?: string[]) =>
  setChannelState(false, guildIds);

export const scheduleService = {
  getSchedule,
  updateSchedule,
  openChannelNow,
  lockChannelNow,
};
