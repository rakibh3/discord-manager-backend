import type { GuildMember, PartialGuildMember } from 'discord.js';

import { prisma } from '@/lib/prisma';
import { normalizeDiscordUsername } from '@/utils/discordUsername';
import { createLogger } from '@/utils/logger';

const logger = createLogger('MemberSync');

/**
 * Member left, was kicked, or was banned.
 *
 * The row is NEVER deleted - attendance and daily-update history must keep a
 * valid owner. It is flagged instead, which is also what lets the attendance
 * form reject a departed member with a plain indexed lookup.
 *
 * Scoped to the guild the member left. Without that `guildId` filter this would
 * flag the same account's record in EVERY configured server, so leaving one
 * server would lock the person out of the attendance form in the other and
 * remove them from its dashboard — a cross-server departure nobody asked for.
 */
export const handleGuildMemberRemove = async (
  member: GuildMember | PartialGuildMember,
): Promise<void> => {
  try {
    if (member.user.bot) return;

    const username = normalizeDiscordUsername(member.user.username);
    logger.info(
      `Member left guild ${member.guild.id}: ${username} (${member.id})`,
    );

    const result = await prisma.discordMember.updateMany({
      where: { guildId: member.guild.id, discordUserId: member.id },
      data: { isInGuild: false, leftAt: new Date() },
    });

    if (result.count === 0) {
      logger.warn(
        `Departing member ${member.id} had no stored record in guild ${member.guild.id}`,
      );
    }
  } catch (error) {
    logger.error(`Failed to flag departing member ${member.id}:`, error);
  }
};
