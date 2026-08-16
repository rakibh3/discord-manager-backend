import type { GuildMember, PartialGuildMember } from 'discord.js';

import { mapGuildMemberToPayload } from '@/lib/discord/member.mapper';
import { upsertMemberPayload } from '@/lib/discord/member.sync';
import { prisma } from '@/lib/prisma';
import { createLogger } from '@/utils/logger';

const logger = createLogger('MemberSync');

/**
 * Nickname / avatar / role change. Only presentation fields are updated -
 * the normalized username is owned by `userUpdate`, since a server nickname
 * is not the account handle.
 */
export const handleGuildMemberUpdate = async (
  _oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember,
): Promise<void> => {
  try {
    if (newMember.user.bot) return;

    const payload = mapGuildMemberToPayload(newMember);

    const result = await prisma.discordMember.updateMany({
      where: { discordUserId: payload.discordUserId },
      data: {
        displayName: payload.displayName,
        globalName: payload.globalName,
        avatarUrl: payload.avatarUrl,
        lastSyncedAt: new Date(),
      },
    });

    // Unknown member: create the record rather than dropping the event.
    if (result.count === 0) {
      await upsertMemberPayload(payload);
      logger.info(
        `Created record from update event: ${payload.discordUsername} (${payload.discordUserId})`,
      );
    }
  } catch (error) {
    logger.error(`Failed to update member ${newMember.id}:`, error);
  }
};
