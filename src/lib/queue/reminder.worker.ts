import {
  ReminderDeliveryStatus,
  ReminderStatus,
} from '@generated/prisma/enums';
import { type Job, Worker } from 'bullmq';

import config from '@/config';
import { getGuildConfig } from '@/lib/discord/client';
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
/**
 * The last fallback attempt PER SERVER.
 *
 * Keyed rather than singular because a missing `Send Messages` in one server is
 * exactly the case that matters, and a single slot would let the healthy
 * server's success overwrite and hide it.
 */
const lastFallbacks = new Map<string, TLastFallback>();

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
  memberIds: string[],
  status: ReminderDeliveryStatus,
  errorMessage: string | null = null,
): Promise<void> => {
  // One send, one outcome, applied to every recipient row that send was
  // responsible for. An account in two configured servers holds a row in each,
  // and both must reach a terminal state — a row left PENDING would hold the
  // whole broadcast open, since leftover PENDING rows are what make
  // `finalizeReminderLog` report FAILED.
  const settled = await reminderRepository.markRecipientOutcomes(
    reminderId,
    memberIds,
    status,
    { errorMessage },
  );

  await reminderRepository.incrementCounts(reminderId, {
    sent: status === ReminderDeliveryStatus.DELIVERED ? settled : 0,
    failed: status === ReminderDeliveryStatus.DELIVERED ? 0 : settled,
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

  const { claimed, log } =
    await reminderRepository.finalizeReminderLog(reminderId);

  // Lost the race, or the broadcast was cancelled and is already terminal.
  if (!claimed) return;

  logger.info(
    `Broadcast ${reminderId} finished: ${log?.sentCount ?? 0} delivered, ${log?.failedCount ?? 0} not delivered.`,
  );

  const closed = await reminderRepository.listClosedDmRecipients(reminderId);

  if (closed.length === 0) return;

  // Grouped by the server each recipient's record belongs to, and posted to
  // THAT server's reminder channel. A member is only ever mentioned in a server
  // they are actually in: mentioning them elsewhere would not reach them and
  // would expose them to a room they are not part of.
  const byGuild = new Map<string, typeof closed>();

  for (const recipient of closed) {
    const bucket = byGuild.get(recipient.member.guildId);

    if (bucket) {
      bucket.push(recipient);
      continue;
    }

    byGuild.set(recipient.member.guildId, [recipient]);
  }

  // Sequential, and each server independently contained: a missing
  // `Send Messages` in one server must not stop the other's fallback from
  // reaching the members who most needed it.
  for (const [guildId, recipients] of byGuild) {
    const guild = getGuildConfig(guildId);

    if (!guild) {
      logger.error(
        `Cannot post the closed-DM fallback for guild ${guildId}: it is no longer configured. ` +
          `${recipients.length} member(s) were not announced.`,
      );

      lastFallbacks.set(guildId, {
        reminderId,
        ranAt: new Date(),
        ok: false,
        mentioned: 0,
        error: 'Server is no longer configured',
        missingPermission: false,
      });
      continue;
    }

    const result: TFallbackResult = await announceClosedDms(
      guild,
      recipients.map((recipient) => ({
        discordUserId: recipient.member.discordUserId,
        discordUsername: recipient.member.discordUsername,
      })),
    );

    lastFallbacks.set(guildId, {
      reminderId,
      ranAt: new Date(),
      ok: result.ok,
      mentioned: result.ok ? result.mentioned : 0,
      error: result.ok ? null : result.error,
      missingPermission: result.ok ? false : result.missingPermission,
    });
  }
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
  const { reminderId, discordUserId, memberIds } = job.data;

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

  const recipients = await reminderRepository.findRecipients(
    reminderId,
    memberIds,
  );

  if (recipients.length === 0) {
    logger.warn(
      `No recipient rows for account ${discordUserId} in broadcast ${reminderId}; dropping.`,
    );
    return;
  }

  // At least one row still PENDING means there is work to do. A partially
  // settled set (one server recorded, the other not) still sends: leaving the
  // second row PENDING forever would stall the broadcast, and this member has
  // not yet been recorded as reached for that server.
  const pending = recipients.filter(
    (recipient) => recipient.status === ReminderDeliveryStatus.PENDING,
  );

  if (pending.length === 0) return;

  const pendingMemberIds = pending.map((recipient) => recipient.memberId);

  // Idempotent: scoped to a PENDING session, so only the first job sets
  // `startedAt` and a cancelled session is never reopened.
  await reminderRepository.markReminderProcessing(reminderId);

  const result = await sendMemberDm(discordUserId, log.message);

  switch (result.status) {
    case 'delivered':
      await recordOutcome(
        reminderId,
        pendingMemberIds,
        ReminderDeliveryStatus.DELIVERED,
      );
      break;

    case 'dm_closed':
      // Not a failure: a fact about this member, which a retry cannot change.
      // Returning normally is what keeps it out of BullMQ's failed set — the
      // fallback announcement is the system's answer to it.
      await recordOutcome(
        reminderId,
        pendingMemberIds,
        ReminderDeliveryStatus.DM_CLOSED,
        'User has DMs disabled',
      );
      break;

    case 'failed':
      await recordOutcome(
        reminderId,
        pendingMemberIds,
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

  const { reminderId, memberIds } = job.data;

  try {
    const recipients = await reminderRepository.findRecipients(
      reminderId,
      memberIds,
    );

    const stillPending = recipients
      .filter(
        (recipient) => recipient.status === ReminderDeliveryStatus.PENDING,
      )
      .map((recipient) => recipient.memberId);

    if (stillPending.length > 0) {
      await recordOutcome(
        reminderId,
        stillPending,
        ReminderDeliveryStatus.FAILED,
        error.message,
      );
    }

    await finalizeIfDrained(reminderId);
  } catch (recordError) {
    logger.error(
      `Could not record the terminal failure for member(s) ${memberIds.join(', ')} in broadcast ${reminderId}:`,
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
    logger.error('Reminder worker did not stop cleanly:', describeError(error));
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
  lastFallbackByGuild: Record<string, TLastFallback>;
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
    lastFallbackByGuild: Object.fromEntries(lastFallbacks.entries()),
  });
