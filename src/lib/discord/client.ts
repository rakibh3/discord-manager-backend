import { Client, Events, GatewayIntentBits, type Guild } from 'discord.js';

import {
  isDiscordConfigured,
  loadDiscordConfig,
  type TDiscordConfig,
} from '@/config/discord';
import { handleGuildMemberAdd } from '@/lib/discord/events/guildMemberAdd';
import { handleGuildMemberRemove } from '@/lib/discord/events/guildMemberRemove';
import { handleGuildMemberUpdate } from '@/lib/discord/events/guildMemberUpdate';
import { handleUserUpdate } from '@/lib/discord/events/userUpdate';
import {
  mapGuildMemberToPayload,
  type TMemberPayload,
} from '@/lib/discord/member.mapper';
import { syncGuildMembers } from '@/lib/discord/member.sync';
import { createLogger } from '@/utils/logger';

const logger = createLogger('DiscordBot');

/**
 * `Guilds` + `GuildMembers` are the minimum needed to enumerate and track the
 * member list. `GuildMembers` is privileged and must be enabled in the
 * Developer Portal.
 */
export const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

let activeConfig: TDiscordConfig | null = null;
let handlersRegistered = false;

export const getDiscordConfig = (): TDiscordConfig | null => activeConfig;

export const isDiscordConnected = (): boolean =>
  discordClient.isReady() && Boolean(discordClient.user);

export const getBotTag = (): string | null => discordClient.user?.tag ?? null;

/** Fetches the configured guild, or null when it is unreachable. */
export const getGuild = async (): Promise<Guild | null> => {
  if (!activeConfig || !isDiscordConnected()) return null;

  try {
    return await discordClient.guilds.fetch(activeConfig.guildId);
  } catch (error) {
    logger.error(
      `Could not fetch configured guild ${activeConfig.guildId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};

/** Resolves a user ID to a full member payload, or null if not in the guild. */
const resolveGuildMember = async (
  userId: string,
): Promise<TMemberPayload | null> => {
  const guild = await getGuild();
  if (!guild) return null;

  try {
    const member = await guild.members.fetch(userId);
    return member.user.bot ? null : mapGuildMemberToPayload(member);
  } catch {
    return null;
  }
};

/** Ignore events originating from any guild other than the configured one. */
const isConfiguredGuild = (guildId: string): boolean =>
  activeConfig?.guildId === guildId;

const registerHandlers = () => {
  if (handlersRegistered) return;
  handlersRegistered = true;

  discordClient.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);

    const guild = await getGuild();
    if (!guild) {
      logger.error(
        'Skipping member sync: the configured guild could not be fetched. ' +
          'Confirm DISCORD_GUILD_ID is correct and that the bot has been invited to that server.',
      );
      return;
    }

    logger.info(
      `Connected to guild "${guild.name}" (${guild.id}), approx ${guild.memberCount} members`,
    );

    // Deliberately not awaited: a ~5,000 member fetch takes tens of seconds
    // and must not hold up anything else.
    void syncGuildMembers(guild);
  });

  discordClient.on(Events.GuildMemberAdd, (member) => {
    if (!isConfiguredGuild(member.guild.id)) return;
    void handleGuildMemberAdd(member);
  });

  discordClient.on(Events.GuildMemberRemove, (member) => {
    if (!isConfiguredGuild(member.guild.id)) return;
    void handleGuildMemberRemove(member);
  });

  discordClient.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (!isConfiguredGuild(newMember.guild.id)) return;
    void handleGuildMemberUpdate(oldMember, newMember);
  });

  discordClient.on(Events.UserUpdate, (oldUser, newUser) => {
    void handleUserUpdate(oldUser, newUser, resolveGuildMember);
  });

  // Never exit on a gateway error - discord.js reconnects on its own.
  discordClient.on(Events.Error, (error) => {
    logger.error('Gateway client error:', error.message);
  });

  discordClient.on(Events.ShardError, (error) => {
    logger.error('Shard error:', error.message);
  });
};

/**
 * Boots the bot. Never throws: a Discord problem must not stop the HTTP API
 * from serving. Returns whether login was attempted and succeeded.
 */
export const startDiscordBot = async (): Promise<boolean> => {
  if (!isDiscordConfigured()) {
    logger.warn(
      'DISCORD_BOT_TOKEN is not set - skipping Discord bot startup. The REST API will run without member sync.',
    );
    return false;
  }

  const result = loadDiscordConfig();
  if (!result.success) {
    logger.error('Invalid Discord configuration; bot not started:');
    result.errors.forEach((message) => logger.error(`  - ${message}`));
    return false;
  }

  activeConfig = result.config;
  registerHandlers();

  try {
    await discordClient.login(activeConfig.botToken);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.toLowerCase().includes('disallowed intents')) {
      logger.error(
        'Login failed: disallowed intents. Enable the "Server Members Intent" under ' +
          'Bot -> Privileged Gateway Intents in the Discord Developer Portal, then restart.',
      );
    } else {
      logger.error(`Login failed: ${message}`);
    }

    return false;
  }
};

/** Destroys the client. Safe to call when the bot never started. */
export const stopDiscordBot = async (): Promise<void> => {
  try {
    await discordClient.destroy();
    logger.info('Discord client destroyed');
  } catch (error) {
    logger.error('Error while destroying Discord client:', error);
  }
};
