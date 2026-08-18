import { prisma } from '@/lib/prisma';

/**
 * Data access for `discord_members` on behalf of the attendance domain.
 *
 * The directory is written by `src/lib/discord/` and read for admin tooling by
 * `discordService`. This file is neither: it is the read path the attendance
 * domain needs, and it lives in `src/repositories/` for the same reason the rest
 * of the layer does — its callers are not all HTTP-scoped. Phase 4's
 * `messageCreate` ingestion must resolve a message author to a member row from
 * inside a gateway listener, and Phase 6's reminder worker must resolve members
 * for DM targeting. Neither can reach into a module service, so the lookup
 * cannot live in one.
 *
 * Repositories own Prisma and nothing else: no `AppError`, no HTTP status codes,
 * no `req`. This file returns data or `null`; deciding that a `null` is a 404
 * belongs to the calling service.
 */

/** The fields the attendance form needs to render a verified badge. */
const verifiedMemberSelect = {
  id: true,
  guildId: true,
  discordUserId: true,
  discordUsername: true,
  displayName: true,
  avatarUrl: true,
} as const;

export type VerifiedMember = {
  id: string;
  /** The configured server this record belongs to. */
  guildId: string;
  discordUserId: string;
  discordUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * Every server in which this handle currently belongs to a present member.
 *
 * Expects an already-normalized handle — `normalizeDiscordUsername` output.
 * Discord stores handles lowercased, and that normalized form is the only value
 * the sync ever writes, so an exact match is correct here. Never `startsWith` /
 * `contains`, which compile to SQL `LIKE`, where `_` is a single-character
 * wildcard and would match most of the directory.
 *
 * Returns a LIST, not a single row, because the handle is unique per server
 * rather than globally. More than one row means one thing only: a Discord
 * handle identifies one account, so those rows are the same person present in
 * several servers. The attendance form uses that to record their submission in
 * every server they belong to, which is what stops them showing as missing in
 * one of them.
 *
 * `isInGuild: true` is part of the query rather than a check in the caller: it
 * is served by the `(guild_id, is_in_guild)` index, and every other consumer of
 * the directory filters the same way. It is evaluated PER SERVER, so someone
 * departed from one server and present in another returns only the latter.
 *
 * Returns an empty array for both "no such row" and "rows exist but the member
 * left everywhere". That collapse is intentional. Golden Rule 3 gives them the
 * same outcome — no submission either way — and keeping them indistinguishable
 * means the endpoint cannot be used to learn that a particular person used to
 * be in a server.
 *
 * Note that a departed member whose handle was later reclaimed by someone else
 * has been renamed to `<handle>#departed-<discordUserId>` by `member.sync.ts`,
 * so it cannot collide with the live holder of the clean handle.
 */
const findActiveMembersByUsername = async (
  normalizedUsername: string,
): Promise<VerifiedMember[]> =>
  prisma.discordMember.findMany({
    where: { discordUsername: normalizedUsername, isInGuild: true },
    select: verifiedMemberSelect,
    orderBy: { guildId: 'asc' },
  });

/** What daily-update ingestion needs to attribute a message to a member row. */
export type IngestionMember = {
  id: string;
  guildId: string;
  discordUserId: string;
  discordUsername: string;
  isInGuild: boolean;
};

/**
 * The member record for this Discord snowflake IN ONE SERVER, or `null`.
 *
 * Resolution is by `discordUserId` and never by handle. Handles are mutable, so
 * a student who renamed between the last sync and posting would either miss
 * their own row or match whoever now holds their old handle — the exact failure
 * `member.sync.ts` upserts on `discordUserId` to avoid. The snowflake is
 * immutable, and `messageCreate` always carries it.
 *
 * The server must be named because the same account can hold a record in
 * several. A message belongs to exactly one server, and crediting it to another
 * server's record would mark the author present where they posted nothing while
 * leaving them missing where they did post.
 *
 * This lookup deliberately does NOT filter `isInGuild: true`, unlike
 * `findActiveMembersByUsername` and every other read of this directory. The
 * asymmetry is load-bearing, so do not "fix" it: the two functions answer
 * different questions. `findActiveMembersByUsername` asks "may this person
 * submit attendance right now?", where a departed member must be refused. This
 * one asks "whose message is this?", and a member who posted at 23:00 and left
 * at 23:30 still owns that message. Filtering here would silently drop their
 * update and shrink the day's completion figures with no error raised anywhere.
 *
 * `isInGuild` is returned rather than filtered on so the caller can log the
 * distinction if it ever matters.
 */
const findMemberByDiscordUserId = async (
  guildId: string,
  discordUserId: string,
): Promise<IngestionMember | null> =>
  prisma.discordMember.findUnique({
    where: { guildId_discordUserId: { guildId, discordUserId } },
    select: {
      id: true,
      guildId: true,
      discordUserId: true,
      discordUsername: true,
      isInGuild: true,
    },
  });

export const memberRepository = {
  findActiveMembersByUsername,
  findMemberByDiscordUserId,
};
