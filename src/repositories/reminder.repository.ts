import type { ReminderLog, ReminderRecipient } from '@generated/prisma/client';
import {
  ReminderDeliveryStatus,
  ReminderStatus,
} from '@generated/prisma/enums';

import { prisma } from '@/lib/prisma';

/**
 * Data access for `reminder_logs` and `reminder_recipients`.
 *
 * The recipient rows are the source of truth for what happened; the counts on
 * the session row are a cache so the SSE progress bar can read one small row
 * instead of aggregating recipients on every poll.
 *
 * Repositories own Prisma and nothing else. The primary caller here is a
 * BullMQ worker, which has no request to fail.
 */

export type CreateReminderLogInput = {
  /** `YYYY-MM-DD`, Asia/Dhaka — the day being reminded about, usually yesterday. */
  reminderDate: string;
  message: string;
  targetCount: number;
  /** The admin who triggered it, if known. */
  createdById?: string | null;
};

const createReminderLog = async (
  input: CreateReminderLogInput,
): Promise<ReminderLog> =>
  prisma.reminderLog.create({
    data: { ...input, status: ReminderStatus.PENDING },
  });

/**
 * Registers the members a broadcast will target, all in one statement.
 *
 * `skipDuplicates` leans on the `(reminder_id, member_id)` unique constraint so
 * re-queuing a broadcast cannot enqueue the same member twice (Golden Rule 4:
 * never burst, never double-send). Returns how many rows were actually new.
 */
const addRecipients = async (
  reminderId: string,
  memberIds: string[],
): Promise<number> => {
  const { count } = await prisma.reminderRecipient.createMany({
    data: memberIds.map((memberId) => ({ reminderId, memberId })),
    skipDuplicates: true,
  });

  return count;
};

/**
 * Moves one recipient to a terminal outcome.
 *
 * Scoped by the `(reminder_id, member_id)` unique key so a retried job updates
 * the existing row rather than creating a second one.
 */
const markRecipientOutcome = async (
  reminderId: string,
  memberId: string,
  status: ReminderDeliveryStatus,
  detail: { errorMessage?: string | null; sentAt?: Date | null } = {},
): Promise<ReminderRecipient> =>
  prisma.reminderRecipient.update({
    where: { reminderId_memberId: { reminderId, memberId } },
    data: {
      status,
      errorMessage: detail.errorMessage ?? null,
      sentAt:
        detail.sentAt ??
        (status === ReminderDeliveryStatus.DELIVERED ? new Date() : null),
    },
  });

/**
 * Bumps the cached progress counters.
 *
 * `increment` is an atomic `SET x = x + n` in Postgres, so concurrent workers
 * cannot lose an update the way a read-modify-write would.
 */
const incrementCounts = async (
  reminderId: string,
  { sent = 0, failed = 0 }: { sent?: number; failed?: number },
): Promise<void> => {
  await prisma.reminderLog.update({
    where: { id: reminderId },
    data: {
      sentCount: { increment: sent },
      failedCount: { increment: failed },
    },
  });
};

/**
 * Moves a broadcast from PENDING to PROCESSING on its first delivered job.
 *
 * Scoped to `status: PENDING` and written as an `updateMany` so that every job
 * can call it unconditionally. Two things depend on that scoping, and both are
 * silent failures if it is dropped:
 *
 *  - `startedAt` records when the run actually began. A plain `update` would
 *    rewrite it on every one of ~5,000 jobs, leaving it meaning "when the last
 *    DM went out" while still being named `startedAt`.
 *  - A CANCELLED session must stay cancelled. A plain `update` would flip it
 *    back to PROCESSING the moment the next queued job ran — which is precisely
 *    the situation cancel exists for — and the worker's status check would then
 *    wave that job through and keep DMing.
 */
const markReminderProcessing = async (reminderId: string): Promise<void> => {
  await prisma.reminderLog.updateMany({
    where: { id: reminderId, status: ReminderStatus.PENDING },
    data: { status: ReminderStatus.PROCESSING, startedAt: new Date() },
  });
};

/** Recipients not yet attempted — the drain check, and the "never attempted" count. */
const countPendingRecipients = async (reminderId: string): Promise<number> =>
  prisma.reminderRecipient.count({
    where: { reminderId, status: ReminderDeliveryStatus.PENDING },
  });

/**
 * Closes out a broadcast by recomputing both counters from the recipient rows
 * rather than trusting the incremented cache.
 *
 * This is what makes the cache safe: a worker that crashed mid-job may have
 * sent a DM without incrementing, leaving the counters permanently wrong. The
 * recipient rows are authoritative, so a final reconciliation repairs them.
 *
 * DM_CLOSED counts as failed delivery — the member did not receive it, and the
 * fallback channel announcement is what reaches them instead.
 *
 * ── Why this is a claim and not an update ─────────────────────────────────
 * Drain is detected by each job counting the recipients still PENDING after it
 * records its own outcome, so two jobs finishing at the same moment can both
 * observe zero and both call this. The write is therefore an `updateMany`
 * scoped to `status: PROCESSING`, which Postgres settles for exactly one
 * caller; `claimed` tells that caller it owns the close-out. The fallback
 * announcement hangs off `claimed`, because the alternative is two mass
 * mentions posted to a channel thousands of students read.
 *
 * The counts are read *before* the claim rather than after, so a crash between
 * the two leaves the session PROCESSING — visibly unfinished, which is true —
 * instead of terminal with stale counters.
 *
 * The `PROCESSING` scope is also what protects a cancelled broadcast: a
 * CANCELLED session is never re-finalized, and its recipients stay PENDING
 * because they were genuinely never attempted.
 */
const finalizeReminderLog = async (
  reminderId: string,
): Promise<{ claimed: boolean; log: ReminderLog | null }> => {
  const [delivered, notDelivered, pending] = await Promise.all([
    prisma.reminderRecipient.count({
      where: { reminderId, status: ReminderDeliveryStatus.DELIVERED },
    }),
    prisma.reminderRecipient.count({
      where: {
        reminderId,
        status: {
          in: [ReminderDeliveryStatus.DM_CLOSED, ReminderDeliveryStatus.FAILED],
        },
      },
    }),
    prisma.reminderRecipient.count({
      where: { reminderId, status: ReminderDeliveryStatus.PENDING },
    }),
  ]);

  const { count } = await prisma.reminderLog.updateMany({
    where: { id: reminderId, status: ReminderStatus.PROCESSING },
    data: {
      sentCount: delivered,
      failedCount: notDelivered,
      // Recipients still PENDING mean the run did not process everyone —
      // reporting COMPLETED there would hide a stalled or crashed worker.
      status: pending > 0 ? ReminderStatus.FAILED : ReminderStatus.COMPLETED,
      completedAt: new Date(),
    },
  });

  if (count === 0) return { claimed: false, log: null };

  return { claimed: true, log: await findReminderLogById(reminderId) };
};

/**
 * Stops a broadcast that is still running.
 *
 * Scoped to the non-terminal statuses so a finished, failed, or already
 * cancelled session is never reopened — `cancelled` is false in that case and
 * the service turns it into a 409 rather than silently doing nothing.
 *
 * The counters are recomputed from the recipient rows on the way out, for the
 * same reason `finalizeReminderLog` does it: the increments are a cache, and a
 * cancelled run is exactly the situation where the cache is most likely to be
 * mid-flight. Recipients never attempted are deliberately left PENDING.
 */
const cancelReminderLog = async (
  reminderId: string,
): Promise<{ cancelled: boolean; log: ReminderLog | null }> => {
  const [delivered, notDelivered] = await Promise.all([
    prisma.reminderRecipient.count({
      where: { reminderId, status: ReminderDeliveryStatus.DELIVERED },
    }),
    prisma.reminderRecipient.count({
      where: {
        reminderId,
        status: {
          in: [ReminderDeliveryStatus.DM_CLOSED, ReminderDeliveryStatus.FAILED],
        },
      },
    }),
  ]);

  const { count } = await prisma.reminderLog.updateMany({
    where: {
      id: reminderId,
      status: { in: [ReminderStatus.PENDING, ReminderStatus.PROCESSING] },
    },
    data: {
      status: ReminderStatus.CANCELLED,
      sentCount: delivered,
      failedCount: notDelivered,
      completedAt: new Date(),
    },
  });

  if (count === 0) return { cancelled: false, log: null };

  return { cancelled: true, log: await findReminderLogById(reminderId) };
};

/**
 * An unfinished broadcast for a date, backing the one-at-a-time guard.
 *
 * A double-clicked button must not schedule a second 40-minute mass DM behind
 * the first.
 */
const findActiveReminderForDate = async (
  reminderDate: string,
): Promise<ReminderLog | null> =>
  prisma.reminderLog.findFirst({
    where: {
      reminderDate,
      status: { in: [ReminderStatus.PENDING, ReminderStatus.PROCESSING] },
    },
    orderBy: { createdAt: 'desc' },
  });

/**
 * Members whose DMs are closed (Discord error 50007), for the batch mention in
 * #daily-update-reminder once the queue has drained.
 * Served by the `(reminder_id, status)` index.
 */
const listClosedDmRecipients = async (reminderId: string) =>
  prisma.reminderRecipient.findMany({
    where: { reminderId, status: ReminderDeliveryStatus.DM_CLOSED },
    select: {
      memberId: true,
      member: {
        select: {
          discordUserId: true,
          discordUsername: true,
          displayName: true,
        },
      },
    },
  });

/** The session row, for the SSE progress read. */
const findReminderLogById = async (
  reminderId: string,
): Promise<ReminderLog | null> =>
  prisma.reminderLog.findUnique({ where: { id: reminderId } });

/** One recipient row, for the job's pre-send state check. */
const findRecipient = async (
  reminderId: string,
  memberId: string,
): Promise<ReminderRecipient | null> =>
  prisma.reminderRecipient.findUnique({
    where: { reminderId_memberId: { reminderId, memberId } },
  });

/**
 * The per-status breakdown for the progress read.
 *
 * Grouped in one query rather than four counts, and returned as a complete
 * record so a status with no rows reads as `0` instead of being absent — the
 * dashboard renders every bucket whether or not anyone landed in it.
 */
const countRecipientsByStatus = async (
  reminderId: string,
): Promise<Record<ReminderDeliveryStatus, number>> => {
  const grouped = await prisma.reminderRecipient.groupBy({
    by: ['status'],
    where: { reminderId },
    _count: { _all: true },
  });

  const counts: Record<ReminderDeliveryStatus, number> = {
    [ReminderDeliveryStatus.PENDING]: 0,
    [ReminderDeliveryStatus.DELIVERED]: 0,
    [ReminderDeliveryStatus.DM_CLOSED]: 0,
    [ReminderDeliveryStatus.FAILED]: 0,
  };

  for (const row of grouped) counts[row.status] = row._count._all;

  return counts;
};

export type PageQuery = {
  page?: number;
  limit?: number;
};

/** Shared paging clamp, so no caller can ask for an unbounded page. */
const toPaging = ({ page = 1, limit = 50 }: PageQuery, maxLimit = 200) => {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), maxLimit);
  const safePage = Math.max(Math.trunc(page) || 1, 1);

  return { take: safeLimit, skip: (safePage - 1) * safeLimit };
};

/** Broadcast history, newest first. The admin who triggered each run may be gone. */
const listReminderLogs = async (query: PageQuery = {}) => {
  const { take, skip } = toPaging(query);

  const [rows, total] = await Promise.all([
    prisma.reminderLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.reminderLog.count(),
  ]);

  return { rows, total };
};

/**
 * One broadcast's recipients, optionally narrowed to a single outcome.
 * The filtered form is served by the `(reminder_id, status)` index.
 *
 * Contact details are deliberately not selected: this is the delivery audit,
 * and the member's phone and email belong to the dashboard's user-detail view
 * rather than being exposed from a second place.
 */
const listRecipients = async (
  reminderId: string,
  { status, ...page }: PageQuery & { status?: ReminderDeliveryStatus } = {},
) => {
  const { take, skip } = toPaging(page);
  const where = { reminderId, ...(status ? { status } : {}) };

  const [rows, total] = await Promise.all([
    prisma.reminderRecipient.findMany({
      where,
      orderBy: { member: { discordUsername: 'asc' } },
      take,
      skip,
      select: {
        id: true,
        memberId: true,
        status: true,
        errorMessage: true,
        sentAt: true,
        member: {
          select: {
            discordUserId: true,
            discordUsername: true,
            displayName: true,
          },
        },
      },
    }),
    prisma.reminderRecipient.count({ where }),
  ]);

  return { rows, total };
};

export const reminderRepository = {
  createReminderLog,
  addRecipients,
  markRecipientOutcome,
  incrementCounts,
  markReminderProcessing,
  countPendingRecipients,
  finalizeReminderLog,
  cancelReminderLog,
  findActiveReminderForDate,
  listClosedDmRecipients,
  findReminderLogById,
  findRecipient,
  countRecipientsByStatus,
  listReminderLogs,
  listRecipients,
};
