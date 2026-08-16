import { ReminderDeliveryStatus } from '@generated/prisma/enums';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { getRedisError,isRedisAvailable } from '@/lib/queue/connection';
import {
  enqueueReminderJobs,
  removeReminderJobs,
} from '@/lib/queue/reminder.queue';
import { getReminderQueueState } from '@/lib/queue/reminder.worker';
import { dailyStatusRepository } from '@/repositories/dailyStatus.repository';
import { reminderRepository } from '@/repositories/reminder.repository';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ReminderService');

/**
 * Business rules for reminder broadcasts.
 *
 * This is the one place in the reminder feature with a request to fail, so it
 * is the one place `AppError` appears. Everything under `src/lib/queue/` and
 * `src/lib/discord/dm.ts` returns values instead, because their caller is a
 * queue job.
 */

type TSendReminderPayload = {
  date: string;
  message: string;
};

/**
 * The members with no daily update on a date — the same list the send uses.
 *
 * Deliberately routed through `dailyStatusRepository`, which owns every
 * dashboard figure. A convenience count assembled here would be drift: it would
 * miss the `is_in_guild` filter that keeps departed members out of both the
 * completion-rate denominator and this target list.
 */
const previewTargets = async (date: string) => {
  const targets = await dailyStatusRepository.listMembersMissingUpdate(date);

  return { date, targetCount: targets.length, targets };
};

/**
 * Starts a broadcast.
 *
 * The order of the guards matters, and each one is here because of what it
 * prevents:
 *
 *  1. Redis first, before anything is written. A session whose rows exist but
 *     whose jobs never got enqueued is the one state that looks finished and is
 *     not — every recipient stuck PENDING forever, with no worker coming.
 *  2. One broadcast per date, so a double-clicked button cannot schedule a
 *     second 40-minute mass DM behind the first.
 *  3. An empty target list is refused rather than producing an empty run.
 *
 * Only then are the session and its recipient rows written — before any job is
 * enqueued, so the database knows the full intended target set before a single
 * DM exists.
 */
const startBroadcast = async (
  { date, message }: TSendReminderPayload,
  adminId: string,
) => {
  if (!isRedisAvailable()) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      `Reminder queue is unavailable: Redis is not reachable (${getRedisError() ?? 'not connected'}). No broadcast was started.`,
    );
  }

  const active = await reminderRepository.findActiveReminderForDate(date);

  if (active) {
    throw new AppError(
      httpStatus.CONFLICT,
      `A reminder broadcast for ${date} is already ${active.status.toLowerCase()} (id ${active.id}). Wait for it to finish, or cancel it first.`,
    );
  }

  const targets = await dailyStatusRepository.listMembersMissingUpdate(date);

  if (targets.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Every member already submitted a daily update for ${date}. There is nobody to remind.`,
    );
  }

  const log = await reminderRepository.createReminderLog({
    reminderDate: date,
    message,
    targetCount: targets.length,
    createdById: adminId,
  });

  await reminderRepository.addRecipients(
    log.id,
    targets.map((target) => target.memberId),
  );

  const enqueued = await enqueueReminderJobs(
    log.id,
    targets.map((target) => ({
      memberId: target.memberId,
      discordUserId: target.discordUserId,
    })),
  );

  // The queue could not take the jobs after the session and its recipient rows
  // were already written. That leaves the one state that looks like a running
  // broadcast and is not: rows waiting on a worker that has nothing to run.
  //
  // Left alone it is worse than useless — it also holds the date's
  // one-at-a-time guard, so every retry answers 409 until somebody cancels it
  // by hand. So the broadcast is cancelled here, which frees the date
  // immediately and records honestly that nothing was delivered.
  if (enqueued === null) {
    await reminderRepository.cancelReminderLog(log.id);

    logger.error(
      `Broadcast ${log.id} was recorded but no jobs could be enqueued; it has been cancelled so the date is not left blocked.`,
    );

    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'The reminder queue could not accept this broadcast, so it was cancelled and nothing was sent. Check the queue status and try again.',
    );
  }

  logger.info(
    `Broadcast ${log.id} started for ${date}: ${targets.length} target(s), ${enqueued} job(s) queued.`,
  );

  return {
    id: log.id,
    reminderDate: log.reminderDate,
    targetCount: log.targetCount,
    queuedJobs: enqueued,
    status: log.status,
  };
};

/** One broadcast with its live progress. */
const getBroadcast = async (reminderId: string) => {
  const log = await reminderRepository.findReminderLogById(reminderId);

  if (!log) {
    throw new AppError(httpStatus.NOT_FOUND, 'Reminder broadcast not found');
  }

  const breakdown =
    await reminderRepository.countRecipientsByStatus(reminderId);

  return {
    id: log.id,
    reminderDate: log.reminderDate,
    message: log.message,
    status: log.status,
    targetCount: log.targetCount,
    // Read from the recipient rows, which are the source of truth, rather than
    // from the cached counters on the session row.
    delivered: breakdown[ReminderDeliveryStatus.DELIVERED],
    dmClosed: breakdown[ReminderDeliveryStatus.DM_CLOSED],
    failed: breakdown[ReminderDeliveryStatus.FAILED],
    outstanding: breakdown[ReminderDeliveryStatus.PENDING],
    startedAt: log.startedAt,
    completedAt: log.completedAt,
    createdAt: log.createdAt,
  };
};

const listBroadcasts = async (query: { page?: number; limit?: number }) => {
  const { rows, total } = await reminderRepository.listReminderLogs(query);

  return { rows, total };
};

const listBroadcastRecipients = async (
  reminderId: string,
  query: { page?: number; limit?: number; status?: ReminderDeliveryStatus },
) => {
  const log = await reminderRepository.findReminderLogById(reminderId);

  if (!log) {
    throw new AppError(httpStatus.NOT_FOUND, 'Reminder broadcast not found');
  }

  return reminderRepository.listRecipients(reminderId, query);
};

/**
 * Stops a broadcast in flight.
 *
 * The status write is the cancel — the worker re-reads it before every send, so
 * queued and in-flight jobs stop delivering whether or not their Redis entries
 * can be removed. Clearing the queue afterwards is housekeeping, and its
 * failure must not turn a successful cancel into an error response.
 */
const cancelBroadcast = async (reminderId: string) => {
  const log = await reminderRepository.findReminderLogById(reminderId);

  if (!log) {
    throw new AppError(httpStatus.NOT_FOUND, 'Reminder broadcast not found');
  }

  const { cancelled } = await reminderRepository.cancelReminderLog(reminderId);

  if (!cancelled) {
    throw new AppError(
      httpStatus.CONFLICT,
      `Broadcast ${reminderId} already finished with status ${log.status} and cannot be cancelled.`,
    );
  }

  // Best effort: the status check above is what actually stops delivery.
  await removeReminderJobs(reminderId);

  logger.info(`Broadcast ${reminderId} cancelled by an administrator.`);

  return getBroadcast(reminderId);
};

/** Queue and worker health, for the dashboard's operational view. */
const getQueueStatus = async () => getReminderQueueState();

export const reminderService = {
  previewTargets,
  startBroadcast,
  getBroadcast,
  listBroadcasts,
  listBroadcastRecipients,
  cancelBroadcast,
  getQueueStatus,
};
