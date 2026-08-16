import cron, { type ScheduledTask } from 'node-cron';

import config from '@/config';
import {
  isDailyUpdateChannelOpen,
  setDailyUpdateChannelOpen,
} from '@/lib/discord/channel.state';
import { isDiscordConnected } from '@/lib/discord/client';
import {
  channelScheduleRepository,
  type TChannelScheduleWithEditor,
} from '@/repositories/channelSchedule.repository';
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
let lastRun: TLastRun | null = null;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const recordRun = (run: TLastRun): void => {
  lastRun = run;
};

/**
 * `<mm> <HH> * * <days>` — minute and hour from the stored `HH:mm`, weekdays
 * straight from `daysOfWeek`, which already uses cron's own 0-6 numbering.
 * Never stored; always derived, so the stored value stays the single source of
 * truth and an admin never sees a cron string.
 */
export const buildCronExpression = (
  time: string,
  daysOfWeek: number[],
): string => {
  const [hour, minute] = time.split(':');

  return `${Number(minute)} ${Number(hour)} * * ${[...daysOfWeek].sort((a, b) => a - b).join(',')}`;
};

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
const runTransition = async (
  open: boolean,
  { trigger, announce }: { trigger: TScheduleTrigger; announce: boolean },
): Promise<void> => {
  const action: TScheduleAction =
    trigger === 'reconcile' ? 'reconcile' : open ? 'open' : 'lock';

  // A doomed Discord call is worse than no call: it produces a confusing API
  // error in the logs when the real problem is that the bot never connected.
  if (!isDiscordConnected()) {
    logger.error(
      `Skipping ${open ? 'open' : 'lock'}: the Discord bot is not connected.`,
    );

    recordRun({
      action,
      trigger,
      ranAt: new Date(),
      ok: false,
      error: 'Discord bot is not connected',
    });
    return;
  }

  const result = await setDailyUpdateChannelOpen(open, { announce });

  recordRun({
    action,
    trigger,
    ranAt: new Date(),
    ok: result.ok,
    error: result.ok ? null : result.error,
  });
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
  try {
    const schedule = await channelScheduleRepository.getOrCreateSchedule();

    // A disabled schedule means "the scheduler is off", not "lock the channel".
    // Forcing a state here would make disabling it a destructive action.
    if (!schedule.enabled) {
      logger.info('Schedule is disabled; leaving the channel as it is.');
      return;
    }

    const shouldBeOpen = isWithinWindow(schedule);
    const actuallyOpen = await isDailyUpdateChannelOpen();

    if (actuallyOpen === null) {
      logger.error(
        'Reconcile skipped: the channel state could not be read. See the error above.',
      );
      recordRun({
        action: 'reconcile',
        trigger: 'reconcile',
        ranAt: new Date(),
        ok: false,
        error: 'Channel state could not be read',
      });
      return;
    }

    if (actuallyOpen === shouldBeOpen) {
      logger.info(
        `Reconcile: channel is already ${shouldBeOpen ? 'open' : 'locked'} as the schedule expects (window ${schedule.openTime}-${schedule.closeTime}, now ${getDhakaTimeOfDay()} Dhaka).`,
      );
      return;
    }

    logger.info(
      `Reconcile: channel is ${actuallyOpen ? 'open' : 'locked'} but the schedule says it should be ` +
        `${shouldBeOpen ? 'open' : 'locked'} (window ${schedule.openTime}-${schedule.closeTime} on days ` +
        `[${schedule.daysOfWeek.join(',')}], now ${getDhakaTimeOfDay()} Dhaka, weekday ${getDhakaWeekday()}). Correcting silently.`,
    );

    await runTransition(shouldBeOpen, {
      trigger: 'reconcile',
      announce: false,
    });
  } catch (error) {
    logger.error('Reconcile failed:', describeError(error));
    recordRun({
      action: 'reconcile',
      trigger: 'reconcile',
      ranAt: new Date(),
      ok: false,
      error: describeError(error),
    });
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
  openTask = cron.schedule(
    openExpression,
    () => runTransition(true, { trigger: 'schedule', announce: true }),
    { timezone: DHAKA_TIMEZONE, name: 'daily-update-open', noOverlap: true },
  );

  lockTask = cron.schedule(
    lockExpression,
    () => runTransition(false, { trigger: 'schedule', announce: true }),
    { timezone: DHAKA_TIMEZONE, name: 'daily-update-lock', noOverlap: true },
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
  lastRun: TLastRun | null;
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
  lastRun,
});
