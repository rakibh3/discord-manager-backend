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

const markReminderProcessing = async (
  reminderId: string,
): Promise<ReminderLog> =>
  prisma.reminderLog.update({
    where: { id: reminderId },
    data: { status: ReminderStatus.PROCESSING, startedAt: new Date() },
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
 */
const finalizeReminderLog = async (
  reminderId: string,
): Promise<ReminderLog> => {
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

  return prisma.reminderLog.update({
    where: { id: reminderId },
    data: {
      sentCount: delivered,
      failedCount: notDelivered,
      // Recipients still PENDING mean the run did not process everyone —
      // reporting COMPLETED there would hide a stalled or crashed worker.
      status: pending > 0 ? ReminderStatus.FAILED : ReminderStatus.COMPLETED,
      completedAt: new Date(),
    },
  });
};

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

export const reminderRepository = {
  createReminderLog,
  addRecipients,
  markRecipientOutcome,
  incrementCounts,
  markReminderProcessing,
  finalizeReminderLog,
  listClosedDmRecipients,
  findReminderLogById,
};
