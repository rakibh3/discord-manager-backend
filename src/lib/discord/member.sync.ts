import { Prisma } from '@generated/prisma/client';
import type { Guild, GuildMember } from 'discord.js';

import {
  mapGuildMemberToPayload,
  type TMemberPayload,
} from '@/lib/discord/member.mapper';
import { prisma } from '@/lib/prisma';
import { isValidDiscordUsername } from '@/utils/discordUsername';
import { createLogger } from '@/utils/logger';

const logger = createLogger('MemberSync');

/** Members written per transaction. Small enough to keep locks short. */
const CHUNK_SIZE = 200;

/**
 * If a full fetch returns fewer than this fraction of the members we already
 * have marked active, we assume the fetch was truncated (almost always the
 * Server Members privileged intent being disabled) and refuse to mark the
 * difference as departed.
 */
const DEPARTURE_GUARD_RATIO = 0.5;

export type TSyncState = {
  running: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  fetched: number;
  synced: number;
  failed: number;
  markedDeparted: number;
  guardTripped: boolean;
  lastError: string | null;
};

const state: TSyncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  fetched: 0,
  synced: 0,
  failed: 0,
  markedDeparted: 0,
  guardTripped: false,
  lastError: null,
};

export const getSyncState = (): TSyncState => ({ ...state });

export const isSyncRunning = (): boolean => state.running;

const isUsernameConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002' &&
  String(error.meta?.target ?? '').includes('discord_username');

const buildUpsert = (payload: TMemberPayload) =>
  prisma.discordMember.upsert({
    where: { discordUserId: payload.discordUserId },
    update: {
      discordUsername: payload.discordUsername,
      displayName: payload.displayName,
      globalName: payload.globalName,
      avatarUrl: payload.avatarUrl,
      isInGuild: true,
      leftAt: null,
      lastSyncedAt: new Date(),
    },
    create: {
      discordUserId: payload.discordUserId,
      discordUsername: payload.discordUsername,
      displayName: payload.displayName,
      globalName: payload.globalName,
      avatarUrl: payload.avatarUrl,
      joinedAt: payload.joinedAt,
      isInGuild: true,
    },
  });

/**
 * Frees a username still held by a different member's row.
 *
 * Discord handles are mutable, so a member can rename onto a handle another
 * stored row still occupies. The stale row is tombstoned with a suffix that
 * can never match a normalized lookup. `isInGuild` is deliberately left alone:
 * the original holder may simply have renamed and still be in the guild, in
 * which case their own upsert later in this same run restores the correct
 * username.
 */
const releaseConflictingUsername = async (
  payload: TMemberPayload,
): Promise<boolean> => {
  const stale = await prisma.discordMember.findUnique({
    where: { discordUsername: payload.discordUsername },
  });

  if (!stale || stale.discordUserId === payload.discordUserId) return false;

  await prisma.discordMember.update({
    where: { id: stale.id },
    data: {
      discordUsername: `${stale.discordUsername}#departed-${stale.discordUserId}`,
    },
  });

  logger.warn(
    `Username "${payload.discordUsername}" reclaimed from ${stale.discordUserId} by ${payload.discordUserId}`,
  );

  return true;
};

/** Upserts one member, retrying once after clearing a username collision. */
export const upsertMemberPayload = async (
  payload: TMemberPayload,
): Promise<void> => {
  try {
    await buildUpsert(payload);
  } catch (error) {
    if (!isUsernameConflict(error)) throw error;

    const released = await releaseConflictingUsername(payload);
    if (!released) throw error;

    await buildUpsert(payload);
  }
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
};

/**
 * Writes one chunk in a single transaction. On any failure the chunk is
 * retried member-by-member so one bad row cannot discard the other 199.
 */
const writeChunk = async (payloads: TMemberPayload[]): Promise<void> => {
  try {
    await prisma.$transaction(payloads.map(buildUpsert));
    state.synced += payloads.length;
    return;
  } catch {
    logger.warn(
      `Chunk of ${payloads.length} failed as a transaction; retrying individually`,
    );
  }

  for (const payload of payloads) {
    try {
      await upsertMemberPayload(payload);
      state.synced += 1;
    } catch (error) {
      state.failed += 1;
      logger.error(
        `Failed to sync member ${payload.discordUserId} (${payload.discordUsername}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
};

/**
 * Marks stored members absent from the fetched set as departed.
 * Skipped entirely when the fetch looks truncated - see DEPARTURE_GUARD_RATIO.
 */
const reconcileDepartures = async (fetchedIds: string[]): Promise<void> => {
  const activeStored = await prisma.discordMember.count({
    where: { isInGuild: true },
  });

  const looksTruncated =
    fetchedIds.length === 0 ||
    (activeStored > 0 &&
      fetchedIds.length < activeStored * DEPARTURE_GUARD_RATIO);

  if (looksTruncated) {
    state.guardTripped = true;
    logger.error(
      `DEPARTURE RECONCILE SKIPPED: fetched ${fetchedIds.length} non-bot members but ${activeStored} are stored as active. ` +
        'This almost always means the Server Members privileged intent is disabled in the Discord Developer Portal. ' +
        'Refusing to mark members as departed based on a truncated member list.',
    );
    return;
  }

  const result = await prisma.discordMember.updateMany({
    where: { isInGuild: true, discordUserId: { notIn: fetchedIds } },
    data: { isInGuild: false, leftAt: new Date() },
  });

  state.markedDeparted = result.count;
};

/**
 * Full guild member sync: fetch every member, upsert non-bots in batches,
 * then reconcile departures. Safe to call repeatedly; refuses to run twice
 * concurrently.
 */
export const syncGuildMembers = async (guild: Guild): Promise<TSyncState> => {
  if (state.running) {
    throw new Error('A member sync is already running');
  }

  state.running = true;
  state.startedAt = new Date();
  state.finishedAt = null;
  state.durationMs = null;
  state.fetched = 0;
  state.synced = 0;
  state.failed = 0;
  state.markedDeparted = 0;
  state.guardTripped = false;
  state.lastError = null;

  const startedAtMs = Date.now();

  try {
    logger.info(`Fetching members for guild ${guild.id}...`);
    const members = await guild.members.fetch();

    const humans = [...members.values()].filter(
      (member: GuildMember) => !member.user.bot,
    );
    state.fetched = humans.length;
    logger.info(
      `Fetched ${members.size} members (${humans.length} non-bot). Writing in chunks of ${CHUNK_SIZE}...`,
    );

    const payloads = humans.map(mapGuildMemberToPayload);

    for (const payload of payloads) {
      if (!isValidDiscordUsername(payload.discordUsername)) {
        // Store it anyway - a missing member means a student who cannot
        // submit attendance, which is worse than a non-conforming handle.
        logger.warn(
          `Member ${payload.discordUserId} has a non-conforming username "${payload.discordUsername}"; storing as-is`,
        );
      }
    }

    for (const batch of chunk(payloads, CHUNK_SIZE)) {
      await writeChunk(batch);
    }

    await reconcileDepartures(payloads.map((p) => p.discordUserId));
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    logger.error('Member sync failed:', state.lastError);
  } finally {
    state.running = false;
    state.finishedAt = new Date();
    state.durationMs = Date.now() - startedAtMs;

    logger.info(
      `Sync complete: ${state.synced} synced, ${state.failed} failed, ` +
        `${state.markedDeparted} marked departed, in ${state.durationMs}ms` +
        (state.guardTripped ? ' (departure reconcile SKIPPED by guard)' : ''),
    );
  }

  return getSyncState();
};
