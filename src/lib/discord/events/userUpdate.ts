import type { PartialUser, User } from 'discord.js';

import type { TGuildConfig } from '@/config/discord';
import type { TMemberPayload } from '@/lib/discord/member.mapper';
import { upsertMemberPayload } from '@/lib/discord/member.sync';
import { createLogger } from '@/utils/logger';

const logger = createLogger('MemberSync');

/**
 * Account-level change (handle, global name, avatar).
 *
 * This is the only event that may rewrite `discordUsername`, because it is the
 * only one carrying the account handle rather than a server nickname. It routes
 * through `upsertMemberPayload` so a rename onto a handle another row still
 * holds is resolved by the same collision handling the full sync uses, and so
 * an event for an unknown user creates the record instead of being dropped.
 *
 * A handle belongs to the ACCOUNT, not to a server, so the change is applied in
 * every configured server that holds a record for it. Updating only the first
 * match would leave the other server's directory holding a handle nobody has
 * any more — and since the attendance form looks members up by handle, that
 * server would refuse the student until the next full sync.
 *
 * Each server is resolved separately, so every write carries its own server's
 * ID and its own nickname; one server failing does not stop the others.
 */
export const handleUserUpdate = async (
  _oldUser: User | PartialUser,
  newUser: User,
  getGuilds: () => TGuildConfig[],
  resolveGuildMember: (
    guildId: string,
    userId: string,
  ) => Promise<TMemberPayload | null>,
): Promise<void> => {
  if (newUser.bot) return;

  for (const { guildId } of getGuilds()) {
    try {
      // Resolving through the guild also picks up the current nickname, so the
      // stored row stays complete rather than half-updated from account fields.
      const payload = await resolveGuildMember(guildId, newUser.id);

      // Not resolvable means they are not in THIS server; a departure event or
      // the next full sync owns that transition, so there is nothing to do for
      // it. Another server may still hold them, so this is a `continue` and
      // never a `return`.
      if (!payload) continue;

      await upsertMemberPayload(payload);

      logger.info(
        `Account updated in guild ${guildId}: ${payload.discordUsername} (${payload.discordUserId})`,
      );
    } catch (error) {
      logger.error(
        `Failed to update user ${newUser.id} in guild ${guildId}:`,
        error,
      );
    }
  }
};
