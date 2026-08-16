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
  discordUserId: true,
  discordUsername: true,
  displayName: true,
  avatarUrl: true,
} as const;

export type VerifiedMember = {
  id: string;
  discordUserId: string;
  discordUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * The member currently in the guild holding this handle, or `null`.
 *
 * Expects an already-normalized handle — `normalizeDiscordUsername` output.
 * Discord stores handles lowercased, and that normalized form is the only value
 * the sync ever writes, so an exact match is correct here.
 *
 * `isInGuild: true` is part of the query rather than a check in the caller: it
 * is served by the `is_in_guild` index, and every other consumer of the
 * directory filters the same way.
 *
 * Returns `null` for both "no such row" and "row exists but the member left".
 * That collapse is intentional. Golden Rule 3 gives them the same outcome — no
 * submission either way — and keeping them indistinguishable means the endpoint
 * cannot be used to learn that a particular person used to be in the server.
 *
 * Note that a departed member whose handle was later reclaimed by someone else
 * has been renamed to `<handle>#departed-<discordUserId>` by `member.sync.ts`,
 * so it cannot collide with the live holder of the clean handle.
 */
const findActiveMemberByUsername = async (
  normalizedUsername: string,
): Promise<VerifiedMember | null> =>
  prisma.discordMember.findFirst({
    where: { discordUsername: normalizedUsername, isInGuild: true },
    select: verifiedMemberSelect,
  });

/** What daily-update ingestion needs to attribute a message to a member row. */
export type IngestionMember = {
  id: string;
  discordUserId: string;
  discordUsername: string;
  isInGuild: boolean;
};

/**
 * The member holding this Discord snowflake, or `null` when none is stored.
 *
 * Resolution is by `discordUserId` and never by handle. Handles are mutable, so
 * a student who renamed between the last sync and posting would either miss
 * their own row or match whoever now holds their old handle — the exact failure
 * `member.sync.ts` upserts on `discordUserId` to avoid. The snowflake is
 * immutable, and `messageCreate` always carries it.
 *
 * This lookup deliberately does NOT filter `isInGuild: true`, unlike
 * `findActiveMemberByUsername` and every other read of this directory. The
 * asymmetry is load-bearing, so do not "fix" it: the two functions answer
 * different questions. `findActiveMemberByUsername` asks "may this person submit
 * attendance right now?", where a departed member must be refused. This one asks
 * "whose message is this?", and a member who posted at 23:00 and left at 23:30
 * still owns that message. Filtering here would silently drop their update and
 * shrink the day's completion figures with no error raised anywhere.
 *
 * `isInGuild` is returned rather than filtered on so the caller can log the
 * distinction if it ever matters.
 */
const findMemberByDiscordUserId = async (
  discordUserId: string,
): Promise<IngestionMember | null> =>
  prisma.discordMember.findUnique({
    where: { discordUserId },
    select: {
      id: true,
      discordUserId: true,
      discordUsername: true,
      isInGuild: true,
    },
  });

export const memberRepository = {
  findActiveMemberByUsername,
  findMemberByDiscordUserId,
};
