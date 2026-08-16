import { Client, Events, GatewayIntentBits, type Guild } from 'discord.js';

import {
  isDiscordConfigured,
  loadDiscordConfig,
  type TDiscordConfig,
} from '@/config/discord';
import { handleGuildMemberAdd } from '@/lib/discord/events/guildMemberAdd';
import { handleGuildMemberRemove } from '@/lib/discord/events/guildMemberRemove';
import { handleGuildMemberUpdate } from '@/lib/discord/events/guildMemberUpdate';
import { handleMessageCreate } from '@/lib/discord/events/messageCreate';
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
 * member list. `GuildMessages` + `MessageContent` are the minimum needed to
 * receive and read `#daily-update` posts. `GuildMembers` and `MessageContent`
 * are both privileged and must be enabled in the Developer Portal.
 */
const buildClient = (includeMessageContent: boolean): Client =>
  new Client({
    intents: includeMessageContent
      ? [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ]
      : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

/**
 * The live client. Deliberately NOT exported: discord.js fixes intents at
 * construction, so the degraded-mode retry has to build a second client, and
 * anything holding the first binding would be left with a dead one — a bug that
 * works fine in the happy path and only appears when the portal toggle is off.
 * Everything outside this module goes through `getDiscordClient()`.
 */
let client: Client = buildClient(true);

let activeConfig: TDiscordConfig | null = null;
let handlersRegistered = false;

/**
 * Whether the bot logged in with `MessageContent`, and so whether
 * `#daily-update` ingestion is running at all. False after a fallback login.
 */
let ingestionEnabled = false;
let ingestionDisabledReason: string | null = 'Discord bot has not started yet';

export const getDiscordClient = (): Client => client;

export const getDiscordConfig = (): TDiscordConfig | null => activeConfig;

export const isDiscordConnected = (): boolean =>
  client.isReady() && Boolean(client.user);

export const getBotTag = (): string | null => client.user?.tag ?? null;

/** Ingestion state, for the admin status endpoint. */
export const getIngestionState = (): {
  enabled: boolean;
  reason: string | null;
} => ({ enabled: ingestionEnabled, reason: ingestionDisabledReason });

/**
 * Runs `callback` once the gateway connection is ready, or immediately if it
 * already is.
 *
 * `client.login()` resolves as soon as the token is accepted, which is before
 * `ClientReady` — anything that needs to fetch a channel or a guild has to wait
 * for this rather than for login. Call it only *after* `startDiscordBot()` has
 * settled: until then the degraded-intent retry may still replace the client,
 * and the listener would be attached to the discarded one.
 */
export const onDiscordReady = (callback: () => void): void => {
  if (client.isReady()) {
    callback();
    return;
  }

  client.once(Events.ClientReady, () => callback());
};

/** Fetches the configured guild, or null when it is unreachable. */
export const getGuild = async (): Promise<Guild | null> => {
  if (!activeConfig || !isDiscordConnected()) return null;

  try {
    return await client.guilds.fetch(activeConfig.guildId);
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

  client.once(Events.ClientReady, async (readyClient) => {
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

  client.on(Events.GuildMemberAdd, (member) => {
    if (!isConfiguredGuild(member.guild.id)) return;
    void handleGuildMemberAdd(member);
  });

  client.on(Events.GuildMemberRemove, (member) => {
    if (!isConfiguredGuild(member.guild.id)) return;
    void handleGuildMemberRemove(member);
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (!isConfiguredGuild(newMember.guild.id)) return;
    void handleGuildMemberUpdate(oldMember, newMember);
  });

  client.on(Events.UserUpdate, (oldUser, newUser) => {
    void handleUserUpdate(oldUser, newUser, resolveGuildMember);
  });

  // Registered structurally rather than checked inside the handler: without
  // MessageContent every message arrives with empty content, so listening
  // would be pure noise.
  if (ingestionEnabled && activeConfig) {
    const { dailyUpdate } = activeConfig.channels;
    const guildId = activeConfig.guildId;

    client.on(Events.MessageCreate, (message) => {
      void handleMessageCreate(message, dailyUpdate, guildId);
    });

    logger.info(`Daily-update ingestion listening on channel ${dailyUpdate}`);
  } else {
    logger.warn(
      'Daily-update ingestion is DISABLED - #daily-update messages will not be recorded ' +
        'and every member will show as missing their update on the dashboard.',
    );
  }

  // Never exit on a gateway error - discord.js reconnects on its own.
  client.on(Events.Error, (error) => {
    logger.error('Gateway client error:', error.message);
  });

  client.on(Events.ShardError, (error) => {
    logger.error('Shard error:', error.message);
  });
};

const isDisallowedIntents = (error: unknown): boolean =>
  (error instanceof Error ? error.message : String(error))
    .toLowerCase()
    .includes('disallowed intents');

/**
 * Boots the bot. Never throws: a Discord problem must not stop the HTTP API
 * from serving. Returns whether login was attempted and succeeded.
 *
 * Discord refuses the entire connection when a client requests a privileged
 * intent that is switched off - it does not degrade to a partial feed. That
 * couples message ingestion to member sync, and member sync is what the public
 * attendance form's membership check depends on. So a missing MessageContent
 * toggle must not be allowed to take the bot down: we retry once without it,
 * which keeps ~5,000 students able to submit attendance while ingestion waits
 * for someone to flip the switch.
 */
export const startDiscordBot = async (): Promise<boolean> => {
  if (!isDiscordConfigured()) {
    logger.warn(
      'DISCORD_BOT_TOKEN is not set - skipping Discord bot startup. The REST API will run without member sync.',
    );
    ingestionDisabledReason = 'DISCORD_BOT_TOKEN is not set';
    return false;
  }

  const result = loadDiscordConfig();
  if (!result.success) {
    logger.error('Invalid Discord configuration; bot not started:');
    result.errors.forEach((message) => logger.error(`  - ${message}`));
    ingestionDisabledReason = 'Discord configuration is invalid';
    return false;
  }

  activeConfig = result.config;
  const { botToken } = activeConfig;

  try {
    ingestionEnabled = true;
    ingestionDisabledReason = null;
    registerHandlers();
    await client.login(botToken);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!isDisallowedIntents(error)) {
      logger.error(`Login failed: ${message}`);
      ingestionEnabled = false;
      ingestionDisabledReason = 'Bot is not logged in';
      return false;
    }

    logger.error(
      'Login rejected for disallowed intents. Enable BOTH "Server Members Intent" and ' +
        '"Message Content Intent" under Bot -> Privileged Gateway Intents in the Discord ' +
        'Developer Portal, then restart.',
    );
    logger.warn(
      'Retrying login WITHOUT Message Content so member sync and the attendance form keep working...',
    );
  }

  // Exactly one retry, and only for this failure. Rebuild the client because
  // intents are fixed at construction, and re-arm the handler guard so the
  // listeners attach to the client that actually logs in.
  ingestionEnabled = false;
  ingestionDisabledReason =
    'Message Content Intent is disabled in the Discord Developer Portal';

  try {
    await client.destroy();
  } catch {
    // The failed client was never connected; nothing to clean up.
  }

  client = buildClient(false);
  handlersRegistered = false;
  registerHandlers();

  try {
    await client.login(botToken);
    logger.warn(
      'Bot running in DEGRADED mode: member sync is active, daily-update ingestion is OFF.',
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isDisallowedIntents(error)) {
      logger.error(
        'Login failed again without Message Content. The remaining privileged intent is ' +
          '"Server Members Intent" - enable it under Bot -> Privileged Gateway Intents, then restart. ' +
          'The REST API continues to serve requests.',
      );
    } else {
      logger.error(`Fallback login failed: ${message}`);
    }

    ingestionDisabledReason = 'Bot is not logged in';
    return false;
  }
};

/** Destroys the client. Safe to call when the bot never started. */
export const stopDiscordBot = async (): Promise<void> => {
  try {
    // Reads the binding at call time, so this always destroys whichever client
    // is current - including one built by the degraded-mode retry.
    await client.destroy();
    logger.info('Discord client destroyed');
  } catch (error) {
    logger.error('Error while destroying Discord client:', error);
  }
};
