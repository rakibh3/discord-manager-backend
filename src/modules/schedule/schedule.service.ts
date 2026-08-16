import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import {
  getDailyUpdateChannelId,
  isDailyUpdateChannelOpen,
  setDailyUpdateChannelOpen,
} from '@/lib/discord/channel.state';
import { isDiscordConnected } from '@/lib/discord/client';
import {
  getSchedulerState,
  recordRun,
  reloadChannelSchedule,
} from '@/lib/scheduler/channelSchedule.scheduler';
import {
  channelScheduleRepository,
  type TChannelScheduleWithEditor,
} from '@/repositories/channelSchedule.repository';
import { DHAKA_TIMEZONE } from '@/utils/dhakaDate';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ScheduleService');

type TUpdateSchedulePayload = {
  openTime?: string;
  closeTime?: string;
  daysOfWeek?: number[];
  enabled?: boolean;
};

/** The stored row plus everything the dashboard needs around it. */
const buildScheduleResponse = async (schedule: TChannelScheduleWithEditor) => {
  const scheduler = getSchedulerState();

  return {
    schedule: {
      openTime: schedule.openTime,
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
    channel: {
      id: getDailyUpdateChannelId(),
      // Read live from Discord rather than from a stored flag — an admin can
      // change the overwrite by hand at any time.
      isOpen: await isDailyUpdateChannelOpen(),
    },
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
  payload: TUpdateSchedulePayload,
  adminId: string,
) => {
  const current = await channelScheduleRepository.getOrCreateSchedule();

  const openTime = payload.openTime ?? current.openTime;
  const closeTime = payload.closeTime ?? current.closeTime;

  if (closeTime <= openTime) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `The close time must be later than the open time on the same day. ` +
        `Received open ${openTime} and close ${closeTime}; a window that crosses midnight is not supported, ` +
        `because a message posted after midnight belongs to the next day's attendance record.`,
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
const setChannelState = async (open: boolean) => {
  if (!isDiscordConnected()) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Discord bot is not connected. Check DISCORD_BOT_TOKEN and the bot logs.',
    );
  }

  const result = await setDailyUpdateChannelOpen(open, { announce: true });

  recordRun({
    action: open ? 'open' : 'lock',
    trigger: 'manual',
    ranAt: new Date(),
    ok: result.ok,
    error: result.ok ? null : result.error,
  });

  if (!result.ok) {
    throw new AppError(
      result.missingPermission
        ? httpStatus.FORBIDDEN
        : httpStatus.SERVICE_UNAVAILABLE,
      result.missingPermission
        ? 'The bot lacks the "Manage Roles" permission on the daily-update channel, so it cannot change who may post there. Grant it in the channel settings and try again.'
        : `The daily-update channel could not be ${open ? 'opened' : 'locked'}: ${result.error}`,
    );
  }

  return {
    channelId: getDailyUpdateChannelId(),
    isOpen: open,
    announced: result.announced,
  };
};

const openChannelNow = () => setChannelState(true);

const lockChannelNow = () => setChannelState(false);

export const scheduleService = {
  getSchedule,
  updateSchedule,
  openChannelNow,
  lockChannelNow,
};
