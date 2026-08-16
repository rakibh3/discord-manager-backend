import type { PartialUser, User } from 'discord.js';

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
 */
export const handleUserUpdate = async (
  _oldUser: User | PartialUser,
  newUser: User,
  resolveGuildMember: (userId: string) => Promise<TMemberPayload | null>,
): Promise<void> => {
  try {
    if (newUser.bot) return;

    // Resolving through the guild also picks up the current nickname, so the
    // stored row stays complete rather than half-updated from account fields.
    const payload = await resolveGuildMember(newUser.id);

    // Not resolvable means they are not in our guild; a departure event or the
    // next full sync owns that transition, so there is nothing to do here.
    if (!payload) return;

    await upsertMemberPayload(payload);

    logger.info(
      `Account updated: ${payload.discordUsername} (${payload.discordUserId})`,
    );
  } catch (error) {
    logger.error(`Failed to update user ${newUser.id}:`, error);
  }
};
