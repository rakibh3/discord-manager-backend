import { type JobsOptions, Queue } from 'bullmq';

import {
  getRedisConnection,
  isRedisAvailable,
} from '@/lib/queue/connection';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ReminderQueue');

export const REMINDER_QUEUE_NAME = 'reminder-dm';

/**
 * What one job knows.
 *
 * Identity only — deliberately NOT the message text. The message lives on the
 * `reminder_logs` row and is read back inside the job, so the text delivered
 * and the text audited cannot diverge. Copying it into ~5,000 Redis payloads
 * would create 5,000 chances for them to disagree, and would make "what did we
 * actually send?" a question with more than one answer.
 *
 * `discordUserId` is carried rather than looked up because it is the one field
 * the send genuinely needs and it never changes, so the payload cannot go stale
 * in a way that matters (Golden Rule 1: DM by snowflake, never by handle).
 */
export type TReminderJobData = {
  reminderId: string;
  memberId: string;
  discordUserId: string;
};

/**
 * Default job options.
 *
 * `attempts` + exponential backoff cover the transient failures only — the
 * worker records terminal outcomes (delivered, DM closed, unknown user) and
 * returns normally rather than throwing, so a retry only ever happens for
 * something that could plausibly succeed on a second try.
 *
 * Completed and failed jobs are evicted on a timer so a nightly 5,000-job
 * broadcast does not accumulate in Redis forever. The durable record is in
 * Postgres — `reminder_recipients` — not in the queue.
 */
const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

let queue: Queue<TReminderJobData> | null = null;

/**
 * The queue, created on first use.
 *
 * Returns `null` when Redis is unreachable rather than constructing a queue
 * whose every call would hang or reject. Callers turn that null into a 503.
 */
export const getReminderQueue = (): Queue<TReminderJobData> | null => {
  if (!isRedisAvailable()) return null;

  queue ??= new Queue<TReminderJobData>(REMINDER_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions,
  });

  return queue;
};

export type TReminderTarget = {
  memberId: string;
  discordUserId: string;
};

/** Enqueued in batches so one 5,000-member broadcast is not one huge pipeline. */
const ENQUEUE_CHUNK_SIZE = 500;

/**
 * Deterministic job id for one broadcast/member pair.
 *
 * `__` rather than the more natural `:` — BullMQ rejects a custom id containing
 * a colon outright ("Custom Id cannot contain :"), because that is the
 * separator in its own Redis key names. Both ids are UUIDs, which contain `-`
 * but never `_`, so this stays unambiguous.
 */
const buildJobId = (reminderId: string, memberId: string): string =>
  `${reminderId}__${memberId}`;

/**
 * Enqueues one job per targeted member.
 *
 * `jobId` is deterministic per pair, so Redis itself rejects a second job for a
 * pair that already has one. That is the cheapest of the three layers standing
 * between a retry and a duplicate DM — the other two being the recipient row's
 * `(reminder_id, member_id)` unique key and the worker's pre-send status check.
 *
 * Returns how many jobs were accepted, or `null` when the queue could not take
 * them — Redis unavailable, or the enqueue itself failing. Never throws: the
 * caller has already written the session and its recipient rows, so it needs a
 * value it can act on rather than an exception that leaves those rows behind
 * with no jobs and no explanation.
 */
export const enqueueReminderJobs = async (
  reminderId: string,
  targets: TReminderTarget[],
): Promise<number | null> => {
  const activeQueue = getReminderQueue();

  if (!activeQueue) return null;

  let enqueued = 0;

  try {
    for (let i = 0; i < targets.length; i += ENQUEUE_CHUNK_SIZE) {
      const chunk = targets.slice(i, i + ENQUEUE_CHUNK_SIZE);

      const jobs = await activeQueue.addBulk(
        chunk.map((target) => ({
          name: 'send-reminder-dm',
          data: {
            reminderId,
            memberId: target.memberId,
            discordUserId: target.discordUserId,
          },
          opts: { jobId: buildJobId(reminderId, target.memberId) },
        })),
      );

      enqueued += jobs.length;
    }
  } catch (error) {
    logger.error(
      `Failed to enqueue reminder jobs for ${reminderId} (${enqueued} of ${targets.length} accepted before the failure):`,
      error instanceof Error ? error.message : error,
    );

    return null;
  }

  logger.info(`Enqueued ${enqueued} reminder job(s) for ${reminderId}.`);

  return enqueued;
};

/**
 * Removes a broadcast's not-yet-started jobs.
 *
 * This is an OPTIMISATION, not the cancel mechanism. A job already in `active`
 * cannot be removed, and removal races the worker either way. What actually
 * stops delivery is the worker re-reading the session status before every send
 * (see `reminder.worker.ts`); this just spares Redis from grinding through
 * thousands of jobs that will each no-op.
 *
 * Failures are logged and swallowed — a cancel whose cleanup failed is still a
 * cancel.
 */
export const removeReminderJobs = async (reminderId: string): Promise<void> => {
  const activeQueue = getReminderQueue();

  if (!activeQueue) return;

  try {
    const jobs = await activeQueue.getJobs(['waiting', 'delayed']);
    const mine = jobs.filter((job) => job.data?.reminderId === reminderId);

    await Promise.all(
      mine.map((job) =>
        job.remove().catch(() => {
          // Already started or already gone; the status check covers it.
        }),
      ),
    );

    logger.info(
      `Removed ${mine.length} queued job(s) for cancelled reminder ${reminderId}.`,
    );
  } catch (error) {
    logger.error(
      `Failed to clear queued jobs for reminder ${reminderId}:`,
      error instanceof Error ? error.message : error,
    );
  }
};

export type TQueueDepth = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
};

/** Outstanding work, for the admin status read. `null` when Redis is unreachable. */
export const getQueueDepth = async (): Promise<TQueueDepth | null> => {
  const activeQueue = getReminderQueue();

  if (!activeQueue) return null;

  try {
    const counts = await activeQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
    );

    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    };
  } catch (error) {
    logger.error(
      'Failed to read queue depth:',
      error instanceof Error ? error.message : error,
    );

    return null;
  }
};

/** Closes the queue during shutdown. Safe when it was never created. */
export const closeReminderQueue = async (): Promise<void> => {
  if (!queue) return;

  try {
    await queue.close();
  } catch {
    // Shutting down; the connection is closed immediately after this.
  } finally {
    queue = null;
  }
};
