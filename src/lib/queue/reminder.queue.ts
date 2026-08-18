import { type JobsOptions, Queue } from 'bullmq';

import { getRedisConnection, isRedisAvailable } from '@/lib/queue/connection';
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
  discordUserId: string;
  /**
   * Every recipient row this one delivery settles.
   *
   * A Discord account that is a member of two configured servers holds a
   * recipient row in each — the per-server audit must stay answerable — but it
   * is ONE person with ONE inbox, so it gets ONE DM. The job is keyed on the
   * account and carries the rows its single outcome applies to.
   */
  memberIds: string[];
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

/** One Discord account, and every member record targeted for it. */
export type TGroupedReminderTarget = {
  discordUserId: string;
  memberIds: string[];
};

/**
 * Collapses per-server targets into one entry per Discord account.
 *
 * This is what makes "one DM per person per broadcast" true. Without it a
 * student in both servers who missed in both would be DMed twice by the same
 * bot within one run — annoying at best, and at ~5,000 members it also doubles
 * the work against a shared rate-limit budget that member sync and the
 * attendance form depend on.
 */
export const groupTargetsByAccount = (
  targets: TReminderTarget[],
): TGroupedReminderTarget[] => {
  const grouped = new Map<string, string[]>();

  for (const target of targets) {
    const existing = grouped.get(target.discordUserId);

    if (existing) {
      existing.push(target.memberId);
      continue;
    }

    grouped.set(target.discordUserId, [target.memberId]);
  }

  return [...grouped.entries()].map(([discordUserId, memberIds]) => ({
    discordUserId,
    memberIds,
  }));
};

/** Enqueued in batches so one 5,000-member broadcast is not one huge pipeline. */
const ENQUEUE_CHUNK_SIZE = 500;

/**
 * Deterministic job id for one broadcast/account pair.
 *
 * Keyed on the DISCORD ACCOUNT rather than the member record, so an account
 * targeted through two servers still produces exactly one job and Redis itself
 * rejects the second.
 *
 * `__` rather than the more natural `:` — BullMQ rejects a custom id containing
 * a colon outright ("Custom Id cannot contain :"), because that is the
 * separator in its own Redis key names. The reminder id is a UUID and the
 * snowflake is digits, neither of which contains `_`, so this stays unambiguous.
 */
const buildJobId = (reminderId: string, discordUserId: string): string =>
  `${reminderId}__${discordUserId}`;

/**
 * Enqueues one job per targeted Discord ACCOUNT, not per member record.
 *
 * `jobId` is deterministic per broadcast/account pair, so Redis itself rejects
 * a second job for a pair that already has one. That is the cheapest of the
 * three layers standing between a retry and a duplicate DM — the other two
 * being the recipient row's `(reminder_id, member_id)` unique key and the
 * worker's pre-send status check.
 *
 * The returned count is therefore the number of PEOPLE being contacted, which
 * can legitimately be lower than the number of recipient rows. Both figures are
 * reported separately so the difference reads as the de-duplication it is
 * rather than as jobs having gone missing.
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

  // Grouped BEFORE anything is enqueued, so the queue never holds two
  // deliveries for one account within a broadcast.
  const grouped = groupTargetsByAccount(targets);

  let enqueued = 0;

  try {
    for (let i = 0; i < grouped.length; i += ENQUEUE_CHUNK_SIZE) {
      const chunk = grouped.slice(i, i + ENQUEUE_CHUNK_SIZE);

      const jobs = await activeQueue.addBulk(
        chunk.map((target) => ({
          name: 'send-reminder-dm',
          data: {
            reminderId,
            discordUserId: target.discordUserId,
            memberIds: target.memberIds,
          },
          opts: { jobId: buildJobId(reminderId, target.discordUserId) },
        })),
      );

      enqueued += jobs.length;
    }
  } catch (error) {
    logger.error(
      `Failed to enqueue reminder jobs for ${reminderId} (${enqueued} of ${grouped.length} accepted before the failure):`,
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
