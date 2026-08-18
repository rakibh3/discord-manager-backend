import type { GuildMember } from 'discord.js';

import { normalizeDiscordUsername } from '@/utils/discordUsername';

export type TMemberPayload = {
  /**
   * The server this member record belongs to, taken from the `GuildMember`
   * itself rather than from configuration. A `GuildMember` is always a member
   * OF a guild, so the payload can never be attributed to the wrong server —
   * which matters because the same account may hold a record in several.
   */
  guildId: string;
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
  guildId: member.guild.id,
  discordUserId: member.id,
  discordUsername: normalizeDiscordUsername(member.user.username),
  displayName: member.displayName || member.user.username,
  globalName: member.user.globalName ?? null,
  avatarUrl: member.user.displayAvatarURL(),
  joinedAt: member.joinedAt,
});
