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
    const schedule = await channelScheduleRepository.getOrCreateSchedule();

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
