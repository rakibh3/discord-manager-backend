import type { GuildMember } from 'discord.js';

import { normalizeDiscordUsername } from '@/utils/discordUsername';

export type TMemberPayload = {
  discordUserId: string;
  discordUsername: string;
  displayName: string;
  globalName: string | null;
  avatarUrl: string;
  joinedAt: Date | null;
};

/**
 * Maps a Discord guild member onto the DiscordMember columns.
 * `discordUsername` is always the normalized account handle - never the
 * display name, which is not unique and changes freely.
 */
export const mapGuildMemberToPayload = (
  member: GuildMember,
): TMemberPayload => ({
  discordUserId: member.id,
  discordUsername: normalizeDiscordUsername(member.user.username),
  displayName: member.displayName || member.user.username,
  globalName: member.user.globalName ?? null,
  avatarUrl: member.user.displayAvatarURL(),
  joinedAt: member.joinedAt,
});
