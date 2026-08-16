import { ReminderDeliveryStatus, ReminderStatus } from '@generated/prisma/enums';
import { type Job, Worker } from 'bullmq';

import config from '@/config';
import {
  announceClosedDms,
  sendMemberDm,
  type TFallbackResult,
} from '@/lib/discord/dm';
import {
  getRedisConnection,
  getRedisError,
  isRedisAvailable,
} from '@/lib/queue/connection';
import {
  getQueueDepth,
  REMINDER_QUEUE_NAME,
  type TQueueDepth,
  type TReminderJobData,
} from '@/lib/queue/reminder.queue';
import { reminderRepository } from '@/repositories/reminder.repository';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ReminderWorker');

/**
 * The reminder DM worker: one job, one recipient, one recorded outcome.
 *
 * Nothing here throws past its own boundary except deliberately — a thrown
 * error is how a job tells BullMQ to retry, and every other failure is caught,
 * logged, and recorded. There is no `AppError` and no HTTP status code in this
 * file; its caller is a queue, not a request.
 */

/** Outcome of the most recent fallback announcement, for the status read. */
export type TLastFallback = {
  reminderId: string;
  ranAt: Date;
  ok: boolean;
  mentioned: number;
  error: string | null;
  missingPermission: boolean;
};

let worker: Worker<TReminderJobData> | null = null;
let lastFallback: TLastFallback | null = null;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Records a recipient's terminal outcome and bumps the session's cached
 * counters.
 *
 * DM_CLOSED counts toward `failedCount`: the member did not receive the DM.
 * The counters are only a cache for the progress read — `finalizeReminderLog`
 * recomputes both from the recipient rows at the end, which is what makes a
 * crashed worker's missed increment recoverable.
 */
const recordOutcome = async (
  reminderId: string,
  memberId: string,
  status: ReminderDeliveryStatus,
  errorMessage: string | null = null,
): Promise<void> => {
  await reminderRepository.markRecipientOutcome(reminderId, memberId, status, {
    errorMessage,
  });

  await reminderRepository.incrementCounts(reminderId, {
    sent: status === ReminderDeliveryStatus.DELIVERED ? 1 : 0,
    failed: status === ReminderDeliveryStatus.DELIVERED ? 0 : 1,
  });
};

/**
 * Closes out a broadcast once its last recipient has an outcome.
 *
 * Drain is detected here, in the database, rather than from BullMQ's `drained`
 * event: that event is queue-wide, so with two broadcasts in flight it says
 * nothing about either. Counting this reminder's still-PENDING recipients is
 * exact.
 *
 * Two jobs finishing at the same instant can both see zero, which is why
 * `finalizeReminderLog` is a claim. Only the caller that wins it posts the
 * fallback — otherwise a channel thousands of students read gets two mass
 * mentions of the same people.
 */
const finalizeIfDrained = async (reminderId: string): Promise<void> => {
  const pending = await reminderRepository.countPendingRecipients(reminderId);

  if (pending > 0) return;

  const { claimed, log } = await reminderRepository.finalizeReminderLog(
    reminderId,
  );

  // Lost the race, or the broadcast was cancelled and is already terminal.
  if (!claimed) return;

  logger.info(
    `Broadcast ${reminderId} finished: ${log?.sentCount ?? 0} delivered, ${log?.failedCount ?? 0} not delivered.`,
  );

  const closed = await reminderRepository.listClosedDmRecipients(reminderId);

  if (closed.length === 0) return;

  const result: TFallbackResult = await announceClosedDms(
    closed.map((recipient) => ({
      discordUserId: recipient.member.discordUserId,
      discordUsername: recipient.member.discordUsername,
    })),
  );

  lastFallback = {
    reminderId,
    ranAt: new Date(),
    ok: result.ok,
    mentioned: result.ok ? result.mentioned : 0,
    error: result.ok ? null : result.error,
    missingPermission: result.ok ? false : result.missingPermission,
  };
};

/**
 * Sends one reminder DM.
 *
 * The order of the checks is the design, not incidental:
 *
 *  1. Read the session. A CANCELLED or otherwise terminal broadcast sends
 *     nothing — this is what actually stops a cancelled run, since jobs already
 *     queued in Redis cannot all be removed in time.
 *  2. Read the recipient row. Anything other than PENDING means this job
 *     already ran and recorded an outcome, so a retry must not re-DM.
 *  3. Only then send.
 *
 * Step 2 narrows, but cannot close, the at-least-once window: a DM that was
 * sent before the process died is not recorded, and the retry sends it again.
 * That is the failure this design accepts. Recording first and sending second
 * would turn it into a member marked as reminded who never was — worse for a
 * feature whose whole purpose is reaching them.
 */
const processReminderJob = async (
  job: Job<TReminderJobData>,
): Promise<void> => {
  const { reminderId, memberId, discordUserId } = job.data;

  const log = await reminderRepository.findReminderLogById(reminderId);

  if (!log) {
    logger.warn(`Job for unknown broadcast ${reminderId}; dropping.`);
    return;
  }

  if (
    log.status === ReminderStatus.CANCELLED ||
    log.status === ReminderStatus.COMPLETED ||
    log.status === ReminderStatus.FAILED
  ) {
    return;
  }

  const recipient = await reminderRepository.findRecipient(
    reminderId,
    memberId,
  );

  if (!recipient) {
    logger.warn(
      `No recipient row for member ${memberId} in broadcast ${reminderId}; dropping.`,
    );
    return;
  }

  if (recipient.status !== ReminderDeliveryStatus.PENDING) return;

  // Idempotent: scoped to a PENDING session, so only the first job sets
  // `startedAt` and a cancelled session is never reopened.
  await reminderRepository.markReminderProcessing(reminderId);

  const result = await sendMemberDm(discordUserId, log.message);

  switch (result.status) {
    case 'delivered':
      await recordOutcome(
        reminderId,
        memberId,
        ReminderDeliveryStatus.DELIVERED,
      );
      break;

    case 'dm_closed':
      // Not a failure: a fact about this member, which a retry cannot change.
      // Returning normally is what keeps it out of BullMQ's failed set — the
      // fallback announcement is the system's answer to it.
      await recordOutcome(
        reminderId,
        memberId,
        ReminderDeliveryStatus.DM_CLOSED,
        'User has DMs disabled',
      );
      break;

    case 'failed':
      await recordOutcome(
        reminderId,
        memberId,
        ReminderDeliveryStatus.FAILED,
        result.error,
      );
      break;

    case 'retryable': {
      // Discord asked us to wait. `worker.rateLimit()` + `RateLimitError` is
      // BullMQ's documented signal to return the job to `wait` WITHOUT
      // consuming a retry attempt, and it pauses the whole worker for the
      // duration. Throwing an ordinary error here instead would burn an
      // attempt per job across the rest of the broadcast for a condition that
      // has nothing to do with any individual recipient.
      if (result.retryAfterMs && worker) {
        await worker.rateLimit(result.retryAfterMs);
        throw Worker.RateLimitError();
      }

      // Everything else transient: leave the recipient PENDING and throw so
      // BullMQ retries with backoff.
      throw new Error(result.error);
    }
  }

  await finalizeIfDrained(reminderId);
};

/**
 * Last-resort outcome writer.
 *
 * A job can die for reasons the processor never observes — a lost lock, a
 * stalled worker, an error thrown between the send and the record. Without
 * this, that recipient stays PENDING forever, and because leftover PENDING
 * rows are what make `finalizeReminderLog` report FAILED, one such row would
 * hold an entire broadcast open indefinitely.
 */
const handleTerminalFailure = async (
  job: Job<TReminderJobData> | undefined,
  error: Error,
): Promise<void> => {
  if (!job) return;

  const attempts = job.opts.attempts ?? 1;

  if (job.attemptsMade < attempts) return;

  const { reminderId, memberId } = job.data;

  try {
    const recipient = await reminderRepository.findRecipient(
      reminderId,
      memberId,
    );

    if (recipient?.status === ReminderDeliveryStatus.PENDING) {
      await recordOutcome(
        reminderId,
        memberId,
        ReminderDeliveryStatus.FAILED,
        error.message,
      );
    }

    await finalizeIfDrained(reminderId);
  } catch (recordError) {
    logger.error(
      `Could not record the terminal failure for member ${memberId} in broadcast ${reminderId}:`,
      describeError(recordError),
    );
  }
};

/**
 * Starts the worker.
 *
 * Never throws: a queue that could not start must not stop the API, the
 * gateway, ingestion, or the channel scheduler. Returns whether it started so
 * the caller can log the outcome.
 */
export const startReminderWorker = (): boolean => {
  if (worker) return true;

  if (!config.reminder_worker_enabled) {
    logger.info(
      'Reminder worker is disabled for this process (REMINDER_WORKER_ENABLED=false). Broadcasts can still be started, read, and cancelled here.',
    );
    return false;
  }

  if (!isRedisAvailable()) {
    logger.warn(
      `Reminder worker not started: Redis is unavailable (${getRedisError() ?? 'not connected'}). Everything else is unaffected.`,
    );
    return false;
  }

  try {
    worker = new Worker<TReminderJobData>(
      REMINDER_QUEUE_NAME,
      processReminderJob,
      {
        connection: getRedisConnection(),
        // Golden Rule 4. The limiter's counter lives in Redis and is shared by
        // every worker on this queue, so two replicas still deliver within ONE
        // budget — unlike node-cron, where a second process doubles the work.
        limiter: { max: config.reminder_dm_per_second, duration: 1000 },
        // The limiter is what paces delivery; concurrency only decides how many
        // jobs may be in flight while waiting on Discord. Small on purpose.
        concurrency: 2,
      },
    );

    worker.on('failed', (job, error) => {
      logger.warn(
        `Reminder job ${job?.id ?? 'unknown'} failed (attempt ${job?.attemptsMade ?? 0}): ${error.message}`,
      );

      void handleTerminalFailure(job, error);
    });

    // Worker-level errors (connection trouble, lock renewal) are logged and
    // contained; discord.js and BullMQ both recover on their own.
    worker.on('error', (error) => {
      logger.error('Reminder worker error:', describeError(error));
    });

    logger.info(
      `Reminder worker started at ${config.reminder_dm_per_second} DM/second.`,
    );

    return true;
  } catch (error) {
    logger.error('Failed to start the reminder worker:', describeError(error));
    worker = null;

    return false;
  }
};

/**
 * Closes the worker, letting a DM already in flight finish.
 *
 * Safe to call when the worker never started. Called before the Discord client
 * is destroyed, so no job sends into a closing gateway connection.
 */
export const stopReminderWorker = async (): Promise<void> => {
  if (!worker) return;

  try {
    await worker.close();
    logger.info('Reminder worker stopped.');
  } catch (error) {
    logger.error(
      'Reminder worker did not stop cleanly:',
      describeError(error),
    );
  } finally {
    worker = null;
  }
};

export type TReminderQueueState = {
  workerRunning: boolean;
  workerEnabled: boolean;
  redisConnected: boolean;
  redisError: string | null;
  dmPerSecond: number;
  queueDepth: TQueueDepth | null;
  lastFallback: TLastFallback | null;
};

/**
 * Runtime health, in the spirit of `getSyncState()` / `getSchedulerState()` /
 * `getIngestionState()`.
 *
 * The fallback outcome is here because it is otherwise invisible: a missing
 * Send Messages permission on the reminder channel delivers every DM
 * successfully and silently reaches nobody who needed the fallback.
 */
export const getReminderQueueState =
  async (): Promise<TReminderQueueState> => ({
    workerRunning: worker !== null,
    workerEnabled: config.reminder_worker_enabled,
    redisConnected: isRedisAvailable(),
    redisError: getRedisError(),
    dmPerSecond: config.reminder_dm_per_second,
    queueDepth: await getQueueDepth(),
    lastFallback,
  });
