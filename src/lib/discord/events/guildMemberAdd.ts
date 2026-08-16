import type { GuildMember } from 'discord.js';

import { mapGuildMemberToPayload } from '@/lib/discord/member.mapper';
import { upsertMemberPayload } from '@/lib/discord/member.sync';
import { createLogger } from '@/utils/logger';

const logger = createLogger('MemberSync');

/** New member joined: create or reactivate their row immediately. */
export const handleGuildMemberAdd = async (
  member: GuildMember,
): Promise<void> => {
  try {
    if (member.user.bot) return;

    const payload = mapGuildMemberToPayload(member);
    await upsertMemberPayload(payload);

    logger.info(
      `New member synced: ${payload.discordUsername} (${payload.discordUserId})`,
    );
  } catch (error) {
    logger.error(`Failed to sync joining member ${member.id}:`, error);
  }
};
