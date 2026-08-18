import { ReminderDeliveryStatus } from '@generated/prisma/enums';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { getConfiguredGuilds } from '@/lib/discord/client';
import { getRedisError, isRedisAvailable } from '@/lib/queue/connection';
import {
  enqueueReminderJobs,
  removeReminderJobs,
} from '@/lib/queue/reminder.queue';
import { getReminderQueueState } from '@/lib/queue/reminder.worker';
import {
  dailyStatusRepository,
  type ReminderCriterionValue,
} from '@/repositories/dailyStatus.repository';
import { reminderRepository } from '@/repositories/reminder.repository';
import { rangeDays, type TResolvedPeriod } from '@/utils/dhakaDate';
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

/**
 * The period and criteria a broadcast runs under, shared by the preview and
 * the send so the two can never compute different target lists.
 */
type TReminderCriteria = {
  period: TResolvedPeriod;
  criterion: ReminderCriterionValue;
  minMissedDays: number;
};

type TSendReminderPayload = TReminderCriteria & {
  message: string;
  /**
   * Restrict the broadcast to named servers. Omitted means every configured
   * server.
   *
   * Narrowing does NOT weaken the one-broadcast-per-date conflict: that guard
   * protects the bot's single shared DM budget, which is global, so two
   * "different server" broadcasts would still be two mass blasts at once.
   */
  guildIds?: string[];
};

/**
 * Refuses a server that is not configured, rather than quietly broadcasting to
 * every server. On a path that sends thousands of DMs, a mistyped ID must not
 * silently widen the blast radius.
 */
const assertConfiguredGuilds = (guildIds?: string[]): void => {
  if (!guildIds?.length) return;

  const known = new Set(getConfiguredGuilds().map((guild) => guild.guildId));
  const unknown = guildIds.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Unknown server(s): ${unknown.join(', ')}. Configured servers are listed at GET /api/discord/servers.`,
    );
  }
};

/**
 * The counted days a period covers, refusing a weekday set that leaves none.
 *
 * A period with no counted days would produce a threshold nobody can meet and
 * an empty broadcast that looks like "everyone is up to date". That has to be
 * an error the admin sees.
 */
const countedDaysOf = (period: TResolvedPeriod): string[] => {
  if (period.mode === 'date') return [period.date];

  const days = rangeDays(period);

  if (days.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `No days in ${period.from}..${period.to} match the selected days of week (${period.daysOfWeek?.join(', ')}). Widen the range or the weekday selection.`,
    );
  }

  return days;
};

/** How a period reads in an error message or a log line. */
const describePeriod = (period: TResolvedPeriod): string =>
  period.mode === 'date' ? period.date : `${period.from}..${period.to}`;

/**
 * The period a response echoes back, tagged so a client never has to infer
 * which form it asked with.
 */
const periodEcho = (period: TResolvedPeriod, daysInRange: number) =>
  period.mode === 'date'
    ? ({ mode: 'date' as const, date: period.date, daysInRange } as const)
    : ({
        mode: 'range' as const,
        from: period.from,
        to: period.to,
        daysOfWeek: period.daysOfWeek?.length ? period.daysOfWeek : null,
        daysInRange,
      } as const);

/**
 * The member records to remind, across every configured server or only those
 * named.
 *
 * Returns one entry per MEMBER RECORD, so an account behind in two servers
 * appears twice — that is the per-server audit. The queue collapses them into
 * one DM per account before anything is sent.
 *
 * Routed through `dailyStatusRepository` rather than assembling a query here,
 * because that repository owns every dashboard figure and the DM must target
 * exactly the people the dashboard shows as behind.
 */
const selectTargets = async (
  { period, criterion, minMissedDays }: TReminderCriteria,
  guildIds?: string[],
) => {
  const days = countedDaysOf(period);
  const query = { days, criterion, minMissedDays };

  if (!guildIds?.length) {
    return dailyStatusRepository.listReminderTargets(query);
  }

  const perGuild = await Promise.all(
    guildIds.map((guildId) =>
      dailyStatusRepository.listReminderTargets({ ...query, guildId }),
    ),
  );

  return perGuild.flat();
};

/**
 * The members with no daily update on a date — the same list the send uses.
 *
 * Deliberately routed through `dailyStatusRepository`, which owns every
 * dashboard figure. A convenience count assembled here would be drift: it would
 * miss the `is_in_guild` filter that keeps departed members out of both the
 * completion-rate denominator and this target list.
 */
const previewTargets = async (
  criteria: TReminderCriteria,
  guildIds?: string[],
) => {
  assertConfiguredGuilds(guildIds);

  const targets = await selectTargets(criteria, guildIds);
  const days = countedDaysOf(criteria.period);

  return {
    ...periodEcho(criteria.period, days.length),
    criterion: criteria.criterion,
    minMissedDays: criteria.minMissedDays,
    /** Recipient rows that would be written — one per member record. */
    targetCount: targets.length,
    /**
     * People who would actually be contacted. Lower than `targetCount` when
     * someone is a member of several servers, because they receive one DM.
     */
    uniqueRecipients: new Set(targets.map((t) => t.discordUserId)).size,
    targets,
  };
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
 *  2. One broadcast per overlapping period, so a double-clicked button cannot
 *     schedule a second 40-minute mass DM behind the first.
 *  3. An empty target list is refused rather than producing an empty run.
 *
 * Only then are the session and its recipient rows written — before any job is
 * enqueued, so the database knows the full intended target set before a single
 * DM exists.
 */
const startBroadcast = async (
  { period, criterion, minMissedDays, message, guildIds }: TSendReminderPayload,
  adminId: string,
) => {
  assertConfiguredGuilds(guildIds);

  if (!isRedisAvailable()) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      `Reminder queue is unavailable: Redis is not reachable (${getRedisError() ?? 'not connected'}). No broadcast was started.`,
    );
  }

  const days = countedDaysOf(period);
  const from = days[0] as string;
  const to = days[days.length - 1] as string;

  // Overlap, not equality: a range and a single date can describe the same day
  // without being the same period, and the budget this guard protects does not
  // care which. Names the conflicting run and its period so an admin can find
  // and cancel it rather than guessing which date is blocked.
  const active = await reminderRepository.findActiveReminderOverlapping(
    from,
    to,
  );

  if (active) {
    throw new AppError(
      httpStatus.CONFLICT,
      `A reminder broadcast covering ${active.reminderStartDate}..${active.reminderEndDate} is already ${active.status.toLowerCase()} (id ${active.id}) and overlaps ${describePeriod(period)}. Wait for it to finish, or cancel it first.`,
    );
  }

  const targets = await selectTargets(
    { period, criterion, minMissedDays },
    guildIds,
  );

  if (targets.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Nobody meets the reminder criteria for ${describePeriod(period)} (${criterion}, at least ${minMissedDays} day(s)). There is nobody to remind.`,
    );
  }

  // The period is stored as the FIRST and LAST counted day rather than the
  // requested `from`/`to`. When a weekday set trims the ends, those are the
  // days the run actually covered, and the overlap guard has to compare what
  // was covered.
  const log = await reminderRepository.createReminderLog({
    reminderStartDate: from,
    reminderEndDate: to,
    criterion,
    minMissedDays,
    daysOfWeek: period.mode === 'range' ? (period.daysOfWeek ?? []) : [],
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
    `Broadcast ${log.id} started for ${describePeriod(period)} (${criterion}, min ${minMissedDays} of ${days.length} day(s)): ${targets.length} target(s), ${enqueued} job(s) queued.`,
  );

  return {
    id: log.id,
    ...periodEcho(period, days.length),
    criterion: log.criterion,
    minMissedDays: log.minMissedDays,
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
    reminderStartDate: log.reminderStartDate,
    reminderEndDate: log.reminderEndDate,
    criterion: log.criterion,
    minMissedDays: log.minMissedDays,
    daysOfWeek: log.daysOfWeek.length ? log.daysOfWeek : null,
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
