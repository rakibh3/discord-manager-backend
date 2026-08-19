import cron, { type ScheduledTask } from 'node-cron';

import config from '@/config';
import type { TGuildConfig } from '@/config/discord';
import {
  isDailyUpdateChannelOpen,
  setDailyUpdateChannelOpen,
} from '@/lib/discord/channel.state';
import {
  getGuildsWithVerifiedChannel,
  isDiscordConnected,
} from '@/lib/discord/client';
import { forEachGuild, type TGuildOutcome } from '@/lib/discord/fanout';
import { announcementRepository } from '@/repositories/announcement.repository';
import {
  channelScheduleRepository,
  type TChannelScheduleWithEditor,
} from '@/repositories/channelSchedule.repository';
import { buildCronExpression } from '@/utils/cron';
import {
  DHAKA_TIMEZONE,
  getDhakaTimeOfDay,
  getDhakaWeekday,
} from '@/utils/dhakaDate';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ChannelScheduler');

/**
 * The timed half of channel automation: open `#daily-update` at the stored open
 * time, lock it at the stored close time, in `Asia/Dhaka`.
 *
 * Like the gateway handlers, this runs outside any request. There is no `req`
 * to fail and no `AppError` to throw — every callback is wrapped, failures are
 * logged and recorded as `lastRun`, and the next day's job stays registered.
 * The HTTP API and the Discord connection must be unaffected by anything that
 * happens in here.
 *
 * Data access goes through `channelScheduleRepository`, which is exactly why
 * the schedule lives in the repository layer: this file and the admin endpoints
 * must read one definition of the schedule, not two.
 *
 * ONE stored schedule drives EVERY configured server. The cron tasks are
 * therefore registered once and fan out inside the callback, rather than one
 * task per server: a single shared schedule must produce a single firing, and
 * N tasks derived from one row would leave a reload that destroyed some but not
 * others firing on a schedule no row describes.
 *
 * Servers are processed sequentially and independently — one server's missing
 * `Manage Roles` must never stop another server's channel from opening.
 */

export type TScheduleAction = 'open' | 'lock' | 'reconcile';
export type TScheduleTrigger = 'schedule' | 'reconcile' | 'manual';

export type TLastRun = {
  action: TScheduleAction;
  trigger: TScheduleTrigger;
  ranAt: Date;
  ok: boolean;
  error: string | null;
};

let openTask: ScheduledTask | null = null;
let lockTask: ScheduledTask | null = null;

/**
 * In-memory, like `getSyncState()` and `getIngestionState()`. A durable record
 * of every open and lock was deliberately left out of this change; what matters
 * operationally is that the *most recent* failure is visible somewhere other
 * than the logs, because a scheduler that cannot edit the overwrite has no
 * other symptom than a channel that never opens.
 */
const lastRuns = new Map<string, TLastRun>();

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const recordRun = (guildId: string, run: TLastRun): void => {
  lastRuns.set(guildId, run);
};

export const getLastRun = (guildId: string): TLastRun | null =>
  lastRuns.get(guildId) ?? null;

/**
 * The servers this scheduler acts on: those whose daily-update channel passed
 * ownership verification at startup. A server whose channel resolves into a
 * different guild is excluded rather than edited — editing it would change the
 * WRONG server's permissions, and with identically named channels nothing about
 * that would look wrong.
 */
export const getSchedulableGuilds = (): TGuildConfig[] =>
  getGuildsWithVerifiedChannel('dailyUpdate');

/**
 * Whether the given Dhaka moment falls inside the schedule's window.
 *
 * Half-open on purpose: `[openTime, closeTime)`. The lock job fires *at*
 * `closeTime`, so from that minute onward the channel is meant to be locked,
 * and a reconcile at 23:59 must agree with the job that just ran rather than
 * reopening the channel behind it.
 *
 * The comparison is lexicographic, which is sound because both sides are
 * zero-padded `HH:mm` — the same property that lets `YYYY-MM-DD` range-scan.
 */
export const isWithinWindow = (
  schedule: Pick<
    TChannelScheduleWithEditor,
    'openTime' | 'closeTime' | 'daysOfWeek'
  >,
  instant: Date = new Date(),
): boolean => {
  if (!schedule.daysOfWeek.includes(getDhakaWeekday(instant))) return false;

  const now = getDhakaTimeOfDay(instant);

  return now >= schedule.openTime && now < schedule.closeTime;
};

/**
 * Applies a state change and records the outcome. The single place any
 * scheduler-driven channel change passes through.
 */
export const applyChannelState = async (
  guilds: TGuildConfig[],
  open: boolean,
  { trigger, announce }: { trigger: TScheduleTrigger; announce: boolean },
): Promise<TGuildOutcome<{ announced: boolean }>[]> => {
  const action: TScheduleAction =
    trigger === 'reconcile' ? 'reconcile' : open ? 'open' : 'lock';

  // A doomed Discord call is worse than no call: it produces a confusing API
  // error in the logs when the real problem is that the bot never connected.
  if (!isDiscordConnected()) {
    logger.error(
      `Skipping ${open ? 'open' : 'lock'}: the Discord bot is not connected.`,
    );

    for (const guild of guilds) {
      recordRun(guild.guildId, {
        action,
        trigger,
        ranAt: new Date(),
        ok: false,
        error: 'Discord bot is not connected',
      });
    }

    return guilds.map((guild) => ({
      guildId: guild.guildId,
      label: guild.label ?? guild.guildId,
      ok: false as const,
      error: 'Discord bot is not connected',
    }));
  }

  // Sequential and individually contained: every server is attempted, and one
  // server's failure is recorded against that server alone.
  return forEachGuild(guilds, async (guild) => {
    const result = await setDailyUpdateChannelOpen(guild, open, { announce });

    recordRun(guild.guildId, {
      action,
      trigger,
      ranAt: new Date(),
      ok: result.ok,
      error: result.ok ? null : result.error,
    });

    if (!result.ok) throw new Error(result.error);

    return { announced: result.announced };
  });
};

/** The scheduled firing: one task, fanning out over every schedulable server. */
const runScheduledTransition = async (open: boolean): Promise<void> => {
  const guilds = getSchedulableGuilds();

  if (guilds.length === 0) {
    logger.error(
      `Skipping ${open ? 'open' : 'lock'}: no configured server has a verified daily-update channel.`,
    );
    return;
  }

  const outcomes = await applyChannelState(guilds, open, {
    trigger: 'schedule',
    announce: true,
  });

  const failed = outcomes.filter((outcome) => !outcome.ok);

  logger.info(
    `Scheduled ${open ? 'open' : 'lock'}: ${outcomes.length - failed.length}/${outcomes.length} server(s) succeeded.`,
  );
};

/**
 * Brings the channel's actual state in line with what the schedule implies for
 * right now, without announcing it.
 *
 * The silence is the point. A container that restarts five times during a
 * deploy would otherwise post "🟢 Channel is OPEN" five times into a channel
 * thousands of students read. An embed marks a transition worth noticing; a
 * reconcile is bookkeeping, and it is logged instead.
 */
export const reconcileChannelState = async (): Promise<void> => {
  let schedule: TChannelScheduleWithEditor;

  try {
    schedule = await channelScheduleRepository.getOrCreateSchedule();
  } catch (error) {
    logger.error(
      'Reconcile failed to read the schedule:',
      describeError(error),
    );
    return;
  }

  // A disabled schedule means "the scheduler is off", not "lock the channel".
  // Forcing a state here would make disabling it a destructive action.
  if (!schedule.enabled) {
    logger.info('Schedule is disabled; leaving every channel as it is.');
    return;
  }

  const shouldBeOpen = isWithinWindow(schedule);

  // Each server is reconciled independently and in its own try/catch: one
  // server whose channel cannot be read must not stop the others from being
  // corrected. A restart at 8 PM otherwise leaves a channel locked all evening
  // with no error raised anywhere.
  for (const guild of getSchedulableGuilds()) {
    try {
      const actuallyOpen = await isDailyUpdateChannelOpen(guild);

      if (actuallyOpen === null) {
        logger.error(
          `Reconcile skipped for guild ${guild.guildId}: the channel state could not be read. See the error above.`,
        );
        recordRun(guild.guildId, {
          action: 'reconcile',
          trigger: 'reconcile',
          ranAt: new Date(),
          ok: false,
          error: 'Channel state could not be read',
        });
        continue;
      }

      if (actuallyOpen === shouldBeOpen) {
        logger.info(
          `Reconcile: channel in guild ${guild.guildId} is already ${shouldBeOpen ? 'open' : 'locked'} as the schedule expects (window ${schedule.openTime}-${schedule.closeTime}, now ${getDhakaTimeOfDay()} Dhaka).`,
        );
        continue;
      }

      logger.info(
        `Reconcile: channel in guild ${guild.guildId} is ${actuallyOpen ? 'open' : 'locked'} but the schedule says it should be ` +
          `${shouldBeOpen ? 'open' : 'locked'} (window ${schedule.openTime}-${schedule.closeTime} on days ` +
          `[${schedule.daysOfWeek.join(',')}], now ${getDhakaTimeOfDay()} Dhaka, weekday ${getDhakaWeekday()}). Correcting silently.`,
      );

      // `announce: false` — a reconcile is bookkeeping, and a deploy that
      // restarts the container five times must not post five embeds per server.
      await applyChannelState([guild], shouldBeOpen, {
        trigger: 'reconcile',
        announce: false,
      });
    } catch (error) {
      logger.error(
        `Reconcile failed for guild ${guild.guildId}:`,
        describeError(error),
      );
      recordRun(guild.guildId, {
        action: 'reconcile',
        trigger: 'reconcile',
        ranAt: new Date(),
        ok: false,
        error: describeError(error),
      });
    }
  }
};

/**
 * Destroys both tasks. `destroy()` rather than `stop()`: a stopped task keeps
 * its old cron expression, and a stale task restarted later would fire on a
 * schedule nobody can see in the database — a bug that only surfaces weeks
 * after the change that caused it.
 */
const destroyTasks = async (): Promise<void> => {
  await Promise.all(
    [openTask, lockTask].map(async (task) => {
      try {
        await task?.destroy();
      } catch (error) {
        logger.error(
          'Failed to destroy a scheduled task:',
          describeError(error),
        );
      }
    }),
  );

  openTask = null;
  lockTask = null;
};

const registerTasks = (schedule: TChannelScheduleWithEditor): void => {
  const openExpression = buildCronExpression(
    schedule.openTime,
    schedule.daysOfWeek,
  );
  const lockExpression = buildCronExpression(
    schedule.closeTime,
    schedule.daysOfWeek,
  );

  // `timezone` is what makes the stored `18:00` mean 18:00 in Dhaka rather than
  // 18:00 wherever the server happens to be. `noOverlap` keeps a slow Discord
  // call from being re-entered by the next firing.
  openTask = cron.schedule(openExpression, () => runScheduledTransition(true), {
    timezone: DHAKA_TIMEZONE,
    name: 'daily-update-open',
    noOverlap: true,
  });

  lockTask = cron.schedule(
    lockExpression,
    () => runScheduledTransition(false),
    {
      timezone: DHAKA_TIMEZONE,
      name: 'daily-update-lock',
      noOverlap: true,
    },
  );

  logger.info(
    `Registered open "${openExpression}" and lock "${lockExpression}" in ${DHAKA_TIMEZONE} ` +
      `(next open ${openTask.getNextRun()?.toISOString() ?? 'never'}, next lock ${lockTask.getNextRun()?.toISOString() ?? 'never'}).`,
  );
};

/**
 * Brings `open_time` back in line with the announcement time at startup.
 *
 * The open time is a mirror of `announcement_templates.announce_time` — the
 * channel opens at the moment students are told to submit — and the save path
 * writes both rows in one transaction. This exists for the states that path
 * cannot reach: a database whose rows predate the mirror, and the narrow window
 * where a crash landed between the transaction committing and this process
 * starting. Since `open_time` is no longer editable on its own, a row left
 * disagreeing would otherwise stay wrong forever with no way for an admin to
 * correct it.
 *
 * Silent when the rows already agree, which is every ordinary boot. A
 * correction is logged loudly, because it means something was firing at the
 * wrong hour until now.
 *
 * The announcement being DISABLED changes nothing here: the time still says
 * when the window belongs, and pausing the message must not quietly move when
 * students can post.
 */
const mirrorAnnounceTimeOntoOpenTime = async (
  schedule: TChannelScheduleWithEditor,
): Promise<TChannelScheduleWithEditor> => {
  const template = await announcementRepository.getOrCreateTemplate();

  if (template.announceTime === schedule.openTime) return schedule;

  // A window that would open at or after it locks is refused rather than
  // written — the same rule the API enforces, applied to data that got in
  // before it did. Nothing throws out of the scheduler, so this is a loud log
  // and the stored open time stands.
  if (template.announceTime >= schedule.closeTime) {
    logger.error(
      `Announce time ${template.announceTime} is not earlier than the close time ${schedule.closeTime}, ` +
        `so the open time stays at ${schedule.openTime}. The channel is opening at a time the announcement ` +
        'no longer matches - fix it by moving the close time, then re-saving the announcement time.',
    );
    return schedule;
  }

  logger.warn(
    `Open time ${schedule.openTime} did not match the announce time ${template.announceTime}; ` +
      'correcting it. The channel opens when the attendance announcement is posted.',
  );

  return channelScheduleRepository.syncOpenTime(template.announceTime);
};

/**
 * Opens the daily-update channel in the servers an announcement just posted to.
 *
 * The manual "Send now" button posts the message that tells students to submit
 * and opens the window they submit through — one action, because the two are
 * one moment. The timed path deliberately does NOT come through here: the open
 * job already fires at the announce time (`open_time` mirrors `announce_time`),
 * and a second permission edit at the busiest minute of the evening would
 * multiply the Discord burst for no change in outcome.
 *
 * Servers already open are skipped rather than re-edited, which is what keeps a
 * forced second send from posting a second "Channel is OPEN" embed into a
 * channel thousands of students read. A server whose state cannot be READ is
 * opened anyway — the edit is idempotent, and refusing to act on an unknown
 * state would leave the window shut on the one server that most needs checking.
 *
 * Never throws: the announcement has already been posted by the time this runs,
 * and a failure to open must not turn a successful send into an error the admin
 * would retry.
 */
export const openChannelsForAnnouncement = async (
  guildIds: string[],
): Promise<{
  outcomes: TGuildOutcome<{ announced: boolean }>[];
  alreadyOpen: string[];
}> => {
  const targets = getSchedulableGuilds().filter((guild) =>
    guildIds.includes(guild.guildId),
  );

  const needsOpening: TGuildConfig[] = [];
  const alreadyOpen: string[] = [];

  // Sequential, like every other fan-out: one live permission read per server,
  // and fan-out must not multiply the instantaneous Discord burst.
  for (const guild of targets) {
    if ((await isDailyUpdateChannelOpen(guild)) === true) {
      alreadyOpen.push(guild.guildId);
      continue;
    }

    needsOpening.push(guild);
  }

  if (needsOpening.length === 0) return { outcomes: [], alreadyOpen };

  // `announce: true`, unlike the boot reconcile: this is a state CHANGE an
  // administrator deliberately triggered, at an hour students are not
  // expecting, so the channel says so. The reconcile is silent because it
  // corrects rather than announces.
  const outcomes = await applyChannelState(needsOpening, true, {
    trigger: 'manual',
    announce: true,
  });

  logger.info(
    `Announcement send opened ${outcomes.filter((o) => o.ok).length}/${outcomes.length} server(s) ` +
      `(${alreadyOpen.length} already open).`,
  );

  return { outcomes, alreadyOpen };
};

/**
 * Loads the schedule, registers the jobs, and reconciles the channel.
 *
 * Never throws: startup calls this after the bot is ready, and a scheduler
 * problem must not take the HTTP API down any more than a Discord problem does.
 */
export const startChannelScheduler = async (): Promise<void> => {
  if (!config.scheduler_enabled) {
    logger.warn(
      'SCHEDULER_ENABLED is false - this process will NOT run the channel open/lock jobs. ' +
        'Exactly one instance should run them. The manual open/lock endpoints still work here.',
    );
    return;
  }

  try {
    const schedule = await mirrorAnnounceTimeOntoOpenTime(
      await channelScheduleRepository.getOrCreateSchedule(),
    );

    await destroyTasks();

    if (!schedule.enabled) {
      logger.warn(
        'Channel schedule is DISABLED in the database - no open/lock jobs registered. ' +
          'Enable it from the admin dashboard (PATCH /api/schedule/daily-update).',
      );
      return;
    }

    registerTasks(schedule);
    await reconcileChannelState();
  } catch (error) {
    logger.error(
      'Failed to start the channel scheduler:',
      describeError(error),
    );
  }
};

/**
 * Re-reads the schedule and rebuilds the jobs in place, then reconciles.
 *
 * Called after an admin saves a change, which is what makes "no restart
 * required" true. A failure here leaves the saved row intact — the save already
 * succeeded — and is surfaced through the status endpoint.
 */
export const reloadChannelSchedule = async (): Promise<void> => {
  if (!config.scheduler_enabled) return;

  logger.info('Reloading the channel schedule...');
  await startChannelScheduler();
};

/** Destroys both tasks. Safe when the scheduler never started. */
export const stopChannelScheduler = async (): Promise<void> => {
  await destroyTasks();
  logger.info('Channel scheduler stopped');
};

export type TSchedulerState = {
  /** Whether THIS process runs the timed jobs — `SCHEDULER_ENABLED`. */
  processEnabled: boolean;
  /** Whether jobs are actually registered right now. */
  running: boolean;
  nextOpenAt: Date | null;
  nextLockAt: Date | null;
  /**
   * The most recent outcome per configured server. Keyed rather than singular
   * because a permission gap in one server is the case that matters, and a
   * single `lastRun` would let the healthy server's success hide it.
   */
  lastRunByGuild: Record<string, TLastRun>;
};

/**
 * Next-run times come from the tasks themselves rather than from a second cron
 * parser, so what is reported is what will actually fire. Both are null when no
 * task is registered — the honest answer for a process that is not scheduling,
 * rather than a time that will never arrive here.
 */
export const getSchedulerState = (): TSchedulerState => ({
  processEnabled: config.scheduler_enabled,
  running: Boolean(openTask && lockTask),
  nextOpenAt: openTask?.getNextRun() ?? null,
  nextLockAt: lockTask?.getNextRun() ?? null,
  lastRunByGuild: Object.fromEntries(lastRuns.entries()),
});
