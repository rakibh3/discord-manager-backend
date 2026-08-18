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
 * One member record's messages on one day, oldest first.
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

/** A message with the server it was posted in, for the merged detail view. */
export type DailyUpdateWithGuild = DailyUpdate & {
  member: { guildId: string };
};

/**
 * One ACCOUNT's messages on one day, oldest first — the dashboard's
 * user-detail modal.
 *
 * Takes every member record of the account rather than one, because a person in
 * two servers posts into whichever `#daily-update` they happen to be in and the
 * detail view is about the person. Each row carries its own `guildId` so the
 * modal can say where the message was posted; ordering is by send time across
 * all of them, so the reader sees one timeline rather than two lists.
 *
 * Served by the same `(member_id, message_date)` index — an `IN` over the two
 * or three member records of one account, not a scan.
 */
const listUpdatesByMemberIdsAndDate = async (
  memberIds: string[],
  messageDate: string,
): Promise<DailyUpdateWithGuild[]> => {
  if (memberIds.length === 0) return [];

  return prisma.dailyUpdate.findMany({
    where: { memberId: { in: memberIds }, messageDate },
    orderBy: { messageCreatedAt: 'asc' },
    include: { member: { select: { guildId: true } } },
  });
};

/**
 * The same read across a whole range: every message these member records
 * posted on any of the counted days, as one timeline.
 *
 * Takes the explicit day list rather than a `from`/`to` pair so the days it
 * reads are exactly the days the range aggregation counted — a weekday the
 * admin excluded must not reappear in the timeline beneath figures that ignore
 * it.
 */
const listUpdatesByMemberIdsAndDates = async (
  memberIds: string[],
  messageDates: string[],
): Promise<DailyUpdateWithGuild[]> => {
  if (memberIds.length === 0 || messageDates.length === 0) return [];

  return prisma.dailyUpdate.findMany({
    where: { memberId: { in: memberIds }, messageDate: { in: messageDates } },
    orderBy: { messageCreatedAt: 'asc' },
    include: { member: { select: { guildId: true } } },
  });
};

// The "how many members posted today" figure deliberately does NOT live here.
// It is one of the seven interlocking numbers in `getDailyStatusCounts`, and
// they have to agree with each other — a second definition of it in this file
// is exactly the drift this layer exists to prevent.

export const dailyUpdateRepository = {
  createDailyUpdate,
  hasUpdateOnDate,
  listUpdatesByMemberAndDate,
  listUpdatesByMemberIdsAndDate,
  listUpdatesByMemberIdsAndDates,
};
