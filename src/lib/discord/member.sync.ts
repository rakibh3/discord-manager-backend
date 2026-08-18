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

const emptyState = (): TSyncState => ({
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
});

/**
 * Sync state per configured server.
 *
 * Keyed rather than singular so one server's run cannot report over another's:
 * the servers are synced independently, they finish at different times, and an
 * operator needs to see which one tripped its guard.
 */
const states = new Map<string, TSyncState>();

const stateFor = (guildId: string): TSyncState => {
  const existing = states.get(guildId);

  if (existing) return existing;

  const created = emptyState();
  states.set(guildId, created);

  return created;
};

export const getSyncState = (guildId: string): TSyncState => ({
  ...stateFor(guildId),
});

export const getAllSyncStates = (): Record<string, TSyncState> =>
  Object.fromEntries([...states.entries()].map(([id, s]) => [id, { ...s }]));

/** Whether THIS server's sync is running. Another server's run does not count. */
export const isSyncRunning = (guildId: string): boolean =>
  stateFor(guildId).running;

/**
 * Whether a P2002 was raised by the username unique.
 *
 * Matches on the serialized `meta` rather than `meta.target`, because under
 * `@prisma/adapter-pg` **`meta.target` is `undefined`** — the constraint arrives
 * at `meta.driverAdapterError.cause.constraint.fields`, a driver-specific path
 * that is not part of Prisma's documented contract. Reading `target` fails
 * silently, which is why the collision repair below never actually ran before
 * this change. Same detection shape as `attendance.service.ts`.
 */
const isUsernameConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002' &&
  JSON.stringify(error.meta ?? {}).includes('discord_username');

const buildUpsert = (payload: TMemberPayload) =>
  prisma.discordMember.upsert({
    // Keyed on (guild, account): the same account legitimately holds a row in
    // every server it belongs to, and keying on the account alone would make
    // one server's sync overwrite the other's record.
    where: {
      guildId_discordUserId: {
        guildId: payload.guildId,
        discordUserId: payload.discordUserId,
      },
    },
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
      guildId: payload.guildId,
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
 * Frees a username still held by a different member's row IN THE SAME SERVER.
 *
 * Discord handles are mutable, so a member can rename onto a handle another
 * stored row still occupies. The stale row is tombstoned with a suffix that
 * can never match a normalized lookup. `isInGuild` is deliberately left alone:
 * the original holder may simply have renamed and still be in the guild, in
 * which case their own upsert later in this same run restores the correct
 * username.
 *
 * Scoped to one server. A row in a DIFFERENT server holding the same handle is
 * not a collision at all — a Discord handle identifies one account globally, so
 * those two rows are the same person in two servers, which is the state the
 * per-server unique exists to allow. Tombstoning across servers would corrupt
 * the other server's directory and lock that person out of its attendance form.
 */
const releaseConflictingUsername = async (
  payload: TMemberPayload,
): Promise<boolean> => {
  const stale = await prisma.discordMember.findUnique({
    where: {
      guildId_discordUsername: {
        guildId: payload.guildId,
        discordUsername: payload.discordUsername,
      },
    },
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
const writeChunk = async (
  state: TSyncState,
  payloads: TMemberPayload[],
): Promise<void> => {
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
 * Marks stored members of ONE server absent from that server's fetched set as
 * departed. Skipped entirely when the fetch looks truncated - see
 * DEPARTURE_GUARD_RATIO.
 *
 * Every query here is scoped to `guildId`, and that scoping is load-bearing in
 * both directions:
 *
 * - The guard's baseline counts only THIS server's active members. Judged
 *   against the whole table, a small server's healthy fetch would look like a
 *   truncated one (and a large server's truncated fetch could look healthy).
 * - The reconcile touches only THIS server's rows. Unscoped, syncing server A
 *   would mark every member of server B departed in a single `updateMany` —
 *   emptying B's dashboard denominator and making its attendance form refuse
 *   every student, with no error raised anywhere.
 */
const reconcileDepartures = async (
  guildId: string,
  state: TSyncState,
  fetchedIds: string[],
): Promise<void> => {
  const activeStored = await prisma.discordMember.count({
    where: { guildId, isInGuild: true },
  });

  const looksTruncated =
    fetchedIds.length === 0 ||
    (activeStored > 0 &&
      fetchedIds.length < activeStored * DEPARTURE_GUARD_RATIO);

  if (looksTruncated) {
    state.guardTripped = true;
    logger.error(
      `DEPARTURE RECONCILE SKIPPED for guild ${guildId}: fetched ${fetchedIds.length} non-bot members but ${activeStored} are stored as active for it. ` +
        'This almost always means the Server Members privileged intent is disabled in the Discord Developer Portal. ' +
        'Refusing to mark members as departed based on a truncated member list.',
    );
    return;
  }

  const result = await prisma.discordMember.updateMany({
    where: { guildId, isInGuild: true, discordUserId: { notIn: fetchedIds } },
    data: { isInGuild: false, leftAt: new Date() },
  });

  state.markedDeparted = result.count;
};

/**
 * Full member sync for ONE server: fetch every member, upsert non-bots in
 * batches, then reconcile that server's departures. Safe to call repeatedly;
 * refuses to run twice concurrently for the same server, while leaving another
 * server free to sync at the same time.
 *
 * Every write it performs is scoped to `guild.id`. Nothing in here may read or
 * modify another server's rows.
 */
export const syncGuildMembers = async (guild: Guild): Promise<TSyncState> => {
  const guildId = guild.id;
  const state = stateFor(guildId);

  // The guard is per server: syncing one server must not be refused because a
  // different server's sync happens to be running.
  if (state.running) {
    throw new Error(`A member sync is already running for guild ${guildId}`);
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
      await writeChunk(state, batch);
    }

    await reconcileDepartures(
      guildId,
      state,
      payloads.map((p) => p.discordUserId),
    );
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    logger.error(`Member sync failed for guild ${guildId}:`, state.lastError);
  } finally {
    state.running = false;
    state.finishedAt = new Date();
    state.durationMs = Date.now() - startedAtMs;

    logger.info(
      `Sync complete for guild ${guildId}: ${state.synced} synced, ${state.failed} failed, ` +
        `${state.markedDeparted} marked departed, in ${state.durationMs}ms` +
        (state.guardTripped ? ' (departure reconcile SKIPPED by guard)' : ''),
    );
  }

  return getSyncState(guildId);
};
