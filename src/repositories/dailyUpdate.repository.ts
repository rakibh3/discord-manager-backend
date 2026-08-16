import type { DailyUpdate } from '@generated/prisma/client';
import { Prisma } from '@generated/prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * Data access for `daily_updates` — messages ingested from #daily-update.
 *
 * Repositories own Prisma and nothing else: no `AppError`, no HTTP status
 * codes, no `req`. The primary caller here is a Discord gateway handler, which
 * has no request to fail.
 */

export type CreateDailyUpdateInput = {
  memberId: string;
  /** The Discord snowflake message ID — the idempotency key. */
  discordMessageId: string;
  channelId: string;
  message: string;
  /** `YYYY-MM-DD`, Asia/Dhaka, derived from `messageCreatedAt` — not from now. */
  messageDate: string;
  /** When the message was sent, not when it was persisted. */
  messageCreatedAt: Date;
};

/**
 * Stores one message, at most once (Golden Rule 7).
 *
 * Idempotent on `discord_message_id`: a gateway event replayed after a bot
 * reconnect hits the unique constraint, which is caught and resolved to the
 * existing row rather than raised. The constraint does the work, so this is
 * safe under concurrent ingestion of the same message — a prior existence
 * check would not be.
 *
 * `created` tells the caller whether this was the first ingestion, so Phase 4
 * can skip re-reacting with ✅ to a message it already acknowledged.
 */
const createDailyUpdate = async (
  input: CreateDailyUpdateInput,
): Promise<{ record: DailyUpdate; created: boolean }> => {
  try {
    return {
      record: await prisma.dailyUpdate.create({ data: input }),
      created: true,
    };
  } catch (error) {
    const isDuplicateMessage =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002';

    if (!isDuplicateMessage) throw error;

    const existing = await prisma.dailyUpdate.findUniqueOrThrow({
      where: { discordMessageId: input.discordMessageId },
    });

    return { record: existing, created: false };
  }
};

/**
 * Whether a member posted at all on one day.
 * Served by the `(member_id, message_date)` index.
 */
const hasUpdateOnDate = async (
  memberId: string,
  messageDate: string,
): Promise<boolean> =>
  (await prisma.dailyUpdate.count({
    where: { memberId, messageDate },
    take: 1,
  })) > 0;

/**
 * One member's messages on one day, oldest first — the dashboard's user-detail
 * modal, which shows every message with its timestamp.
 * Served by the `(member_id, message_date)` index.
 */
const listUpdatesByMemberAndDate = async (
  memberId: string,
  messageDate: string,
): Promise<DailyUpdate[]> =>
  prisma.dailyUpdate.findMany({
    where: { memberId, messageDate },
    orderBy: { messageCreatedAt: 'asc' },
  });

// The "how many members posted today" figure deliberately does NOT live here.
// It is one of the seven interlocking numbers in `getDailyStatusCounts`, and
// they have to agree with each other — a second definition of it in this file
// is exactly the drift this layer exists to prevent.

export const dailyUpdateRepository = {
  createDailyUpdate,
  hasUpdateOnDate,
  listUpdatesByMemberAndDate,
};
