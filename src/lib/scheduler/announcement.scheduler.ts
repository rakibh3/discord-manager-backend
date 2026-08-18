import cron, { type ScheduledTask } from 'node-cron';

import config from '@/config';
import {
  dispatchAttendanceAnnouncement,
  getLastAnnouncementOutcome,
  type TLastAnnouncementOutcome,
} from '@/lib/announcement/announcement.dispatch';
import { announcementRepository } from '@/repositories/announcement.repository';
import { buildCronExpression } from '@/utils/cron';
import { DHAKA_TIMEZONE } from '@/utils/dhakaDate';
import { createLogger } from '@/utils/logger';

const logger = createLogger('AnnouncementScheduler');

/**
 * The timed half of the attendance announcement: post the stored message at the
 * stored time, in `Asia/Dhaka`, on the stored weekdays.
 *
 * A separate file and a separate task from the channel scheduler, deliberately.
 * The two run at the same hour today and share nothing else: disabling either
 * leaves the other running, and a failure in one cannot stop the other. What
 * they do share is a *value* — the stored close time, read at render time — so
 * the message can never state a closing time different from the one that
 * actually locks the channel.
 *
 * Like every scheduler in this codebase, nothing here throws past its own
 * boundary: `dispatchAttendanceAnnouncement` returns a result for every path and
 * the next day's task stays registered whatever happened tonight.
 */

let announcementTask: ScheduledTask | null = null;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Destroys the task. `destroy()` rather than `stop()`: a stopped task keeps its
 * old cron expression, and restarted later it would fire on a schedule nobody
 * can see in the database — a bug that surfaces weeks after the change that
 * caused it.
 */
const destroyTask = async (): Promise<void> => {
  try {
    await announcementTask?.destroy();
  } catch (error) {
    logger.error(
      'Failed to destroy the announcement task:',
      describeError(error),
    );
  }

  announcementTask = null;
};

/**
 * Loads the template and registers the timed post.
 *
 * ── There is deliberately no boot reconcile ───────────────────────────────
 * The channel scheduler reconciles at startup because a locked channel at 8 PM
 * is a state to correct. A missed announcement is not a state — it is a moment
 * that passed. Posting "today's announcement" at 21:40 because a container
 * restarted then would be worse than the gap it fills, and a deploy that
 * restarts five times would post it five times. The status endpoint reports that
 * today has not been posted, and the manual send exists for exactly that case.
 *
 * Never throws: startup calls this after the bot is ready, and a scheduler
 * problem must not take the HTTP API down any more than a Discord problem does.
 */
export const startAnnouncementScheduler = async (): Promise<void> => {
  if (!config.scheduler_enabled) {
    logger.warn(
      'SCHEDULER_ENABLED is false - this process will NOT run the timed attendance announcement. ' +
        'Exactly one instance should run it, because node-cron is process-local and N replicas would ' +
        'post N announcements. The manual send endpoint still works here.',
    );
    return;
  }

  try {
    const template = await announcementRepository.getOrCreateTemplate();

    await destroyTask();

    if (!template.enabled) {
      logger.warn(
        'The attendance announcement is DISABLED in the database - no task registered. ' +
          'Enable it from the admin dashboard (PATCH /api/announcement/attendance).',
      );
      return;
    }

    const expression = buildCronExpression(
      template.announceTime,
      template.daysOfWeek,
    );

    // `timezone` is what makes the stored `19:00` mean 19:00 in Dhaka rather
    // than 19:00 wherever the server happens to be. `noOverlap` keeps a slow
    // Discord call from being re-entered by the next firing.
    announcementTask = cron.schedule(
      expression,
      () => void dispatchAttendanceAnnouncement({ trigger: 'SCHEDULED' }),
      {
        timezone: DHAKA_TIMEZONE,
        name: 'attendance-announcement',
        noOverlap: true,
      },
    );

    logger.info(
      `Registered the attendance announcement "${expression}" in ${DHAKA_TIMEZONE} ` +
        `(next run ${announcementTask.getNextRun()?.toISOString() ?? 'never'}).`,
    );
  } catch (error) {
    logger.error(
      'Failed to start the announcement scheduler:',
      describeError(error),
    );
  }
};

/**
 * Re-reads the template and rebuilds the task in place.
 *
 * Called after an admin saves a change, which is what makes "no restart
 * required" true. A failure here leaves the saved row intact — the save already
 * succeeded — and is visible through the status endpoint.
 */
export const reloadAnnouncementSchedule = async (): Promise<void> => {
  if (!config.scheduler_enabled) return;

  logger.info('Reloading the attendance announcement schedule...');
  await startAnnouncementScheduler();
};

/** Destroys the task. Safe when the scheduler never started. */
export const stopAnnouncementScheduler = async (): Promise<void> => {
  await destroyTask();
  logger.info('Announcement scheduler stopped');
};

export type TAnnouncementSchedulerState = {
  /** Whether THIS process runs the timed post — `SCHEDULER_ENABLED`. */
  processEnabled: boolean;
  /** Whether a task is actually registered right now. */
  running: boolean;
  nextRunAt: Date | null;
  lastOutcome: TLastAnnouncementOutcome | null;
};

/**
 * The next run time comes from the task itself rather than from a second cron
 * parser, so what is reported is what will actually fire. It is null when no
 * task is registered — the honest answer for a process that is not scheduling,
 * rather than a time that will never arrive here.
 */
export const getAnnouncementSchedulerState =
  (): TAnnouncementSchedulerState => ({
    processEnabled: config.scheduler_enabled,
    running: Boolean(announcementTask),
    nextRunAt: announcementTask?.getNextRun() ?? null,
    lastOutcome: getLastAnnouncementOutcome(),
  });
