import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import {
  getBotTag,
  getDiscordConfig,
  getGuild,
  isDiscordConnected,
} from '@/lib/discord/client';
import {
  getSyncState,
  isSyncRunning,
  syncGuildMembers,
} from '@/lib/discord/member.sync';
import { prisma } from '@/lib/prisma';

// Bot connection state, stored member counts, and the last sync outcome
const getSyncStatusFromDB = async () => {
  const config = getDiscordConfig();

  const [total, active] = await Promise.all([
    prisma.discordMember.count(),
    prisma.discordMember.count({ where: { isInGuild: true } }),
  ]);

  return {
    bot: {
      connected: isDiscordConnected(),
      tag: getBotTag(),
      guildId: config?.guildId ?? null,
    },
    members: {
      total,
      active,
      departed: total - active,
    },
    lastSync: getSyncState(),
  };
};

// Kick off a full re-sync without blocking the response
const triggerMemberSync = async () => {
  if (!isDiscordConnected()) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Discord bot is not connected. Check DISCORD_BOT_TOKEN and the bot logs.',
    );
  }

  if (isSyncRunning()) {
    throw new AppError(
      httpStatus.CONFLICT,
      'A member sync is already running. Wait for it to finish before starting another.',
    );
  }

  const guild = await getGuild();

  if (!guild) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'The configured Discord guild could not be fetched. Check DISCORD_GUILD_ID and that the bot is a member of that server.',
    );
  }

  // Not awaited: a full sync takes tens of seconds, far longer than a request.
  void syncGuildMembers(guild);

  return {
    accepted: true,
    guildId: guild.id,
    startedAt: new Date(),
  };
};

export const discordService = {
  getSyncStatusFromDB,
  triggerMemberSync,
};
