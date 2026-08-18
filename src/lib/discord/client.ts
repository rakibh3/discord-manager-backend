import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
} from 'discord.js';

import {
  isDiscordConfigured,
  loadDiscordConfig,
  type TDiscordConfig,
  type TGuildChannels,
  type TGuildConfig,
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
 * What the bot learned about each configured server once it connected.
 *
 * Configuration says which servers *should* exist; this says which of them the
 * bot can actually reach and whose channels actually belong to them. The two
 * are deliberately separate: a server that is misconfigured or that the bot was
 * never invited to must be reportable, not merely absent.
 */
export type TGuildRuntimeState = {
  config: TGuildConfig;
  /** Whether the guild itself could be fetched. */
  reachable: boolean;
  unreachableReason: string | null;
  name: string | null;
  memberCount: number | null;
  /**
   * Per-channel ownership verification: `null` means verified, a string is why
   * that channel is unusable for this server.
   */
  channels: Record<keyof TGuildChannels, string | null>;
  verifiedAt: Date | null;
};

const guildStates = new Map<string, TGuildRuntimeState>();

/**
 * Whether the bot logged in with `MessageContent`, and so whether
 * `#daily-update` ingestion is running at all. False after a fallback login.
 */
let ingestionEnabled = false;
let ingestionDisabledReason: string | null = 'Discord bot has not started yet';

export const getDiscordClient = (): Client => client;

export const getDiscordConfig = (): TDiscordConfig | null => activeConfig;

/**
 * Every configured server, in configuration order.
 *
 * This is the ONLY way to learn which servers exist. There is deliberately no
 * accessor returning "the guild": a singular accessor is exactly how a feature
 * quietly starts serving one server and ignoring the rest, and with identical
 * channel names in every server that mistake looks like nothing is wrong.
 */
export const getConfiguredGuilds = (): TGuildConfig[] =>
  activeConfig?.guilds ?? [];

/** The configured server an event came from, or `null` when it is not ours. */
export const getGuildConfig = (guildId: string): TGuildConfig | null =>
  activeConfig?.guilds.find((guild) => guild.guildId === guildId) ?? null;

/** Runtime state for every configured server, for the status endpoints. */
export const getGuildRuntimeStates = (): TGuildRuntimeState[] =>
  getConfiguredGuilds().map(
    (config) =>
      guildStates.get(config.guildId) ?? {
        config,
        reachable: false,
        unreachableReason: 'The bot has not connected yet',
        name: null,
        memberCount: null,
        channels: { attendance: null, dailyUpdate: null, reminder: null },
        verifiedAt: null,
      },
  );

/**
 * The configured servers the bot is actually in. This is what fan-out iterates:
 * a server the bot was never invited to is skipped rather than failing N times
 * per evening.
 */
export const getReadyGuilds = (): TGuildConfig[] =>
  getGuildRuntimeStates()
    .filter((state) => state.reachable)
    .map((state) => state.config);

/**
 * The servers whose named channel passed ownership verification.
 *
 * Features fan out over this rather than over `getReadyGuilds()`, so a server
 * whose channel points into the wrong guild is excluded from that feature
 * instead of writing into another server's channel.
 */
export const getGuildsWithVerifiedChannel = (
  channel: keyof TGuildChannels,
): TGuildConfig[] =>
  getGuildRuntimeStates()
    .filter((state) => state.reachable && state.channels[channel] === null)
    .map((state) => state.config);

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

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Fetches one configured guild, or null when it is unreachable. */
export const fetchGuild = async (guildId: string): Promise<Guild | null> => {
  if (!isDiscordConnected()) return null;

  try {
    return await client.guilds.fetch(guildId);
  } catch (error) {
    logger.error(
      `Could not fetch configured guild ${guildId}:`,
      describeError(error),
    );
    return null;
  }
};

/**
 * Resolves a user ID to a member payload for ONE server, or null when they are
 * not in it. The payload carries that server's ID, so a caller cannot
 * accidentally write it against another server's row.
 */
export const resolveGuildMember = async (
  guildId: string,
  userId: string,
): Promise<TMemberPayload | null> => {
  const guild = await fetchGuild(guildId);
  if (!guild) return null;

  try {
    const member = await guild.members.fetch(userId);
    return member.user.bot ? null : mapGuildMemberToPayload(member);
  } catch {
    return null;
  }
};

/**
 * Verifies that one configured channel really belongs to the server it was
 * configured under. Returns `null` when it does, or the reason it does not.
 *
 * This is the only check that can catch a SWAPPED configuration. The static
 * validation in `config/discord.ts` sees four lists of equal length full of
 * distinct valid snowflakes and passes — and because every server names its
 * channels identically, so does a human reading either the config or Discord.
 * A swap is silent and severe in three directions at once: ingestion compares
 * an incoming message's channel against its own guild's config and so ignores
 * EVERY message in BOTH servers, the scheduler opens and locks the wrong
 * server's channel, and the announcement posts into the wrong server looking
 * entirely correct.
 */
const verifyChannel = async (
  guildId: string,
  label: string,
  channelId: string,
): Promise<string | null> => {
  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel) {
      return `${label} channel ${channelId} could not be resolved`;
    }

    if (channel.type !== ChannelType.GuildText) {
      return `${label} channel ${channelId} is not a text channel`;
    }

    if (channel.guild.id !== guildId) {
      return (
        `${label} channel ${channelId} belongs to guild ${channel.guild.id}, not ${guildId}. ` +
        'The channel ID lists are positional — check that entry N of every list describes the same server.'
      );
    }

    return null;
  } catch (error) {
    return `${label} channel ${channelId} could not be fetched: ${describeError(error)}`;
  }
};

/**
 * Fetches every configured guild, verifies its three channels, and records the
 * outcome. A server that fails is reported and excluded; the others carry on.
 */
const verifyConfiguredGuilds = async (): Promise<void> => {
  for (const config of getConfiguredGuilds()) {
    const { guildId } = config;
    const guild = await fetchGuild(guildId);

    if (!guild) {
      guildStates.set(guildId, {
        config,
        reachable: false,
        unreachableReason:
          'The guild could not be fetched. Confirm the ID is correct and that the bot has been invited to that server.',
        name: null,
        memberCount: null,
        channels: { attendance: null, dailyUpdate: null, reminder: null },
        verifiedAt: new Date(),
      });

      logger.error(
        `Configured guild ${guildId} is unreachable; it will be skipped. ` +
          'Confirm DISCORD_GUILD_IDS is correct and that the bot has been invited to that server.',
      );
      continue;
    }

    const channels = {
      attendance: await verifyChannel(
        guildId,
        'attendance',
        config.channels.attendance,
      ),
      dailyUpdate: await verifyChannel(
        guildId,
        'daily-update',
        config.channels.dailyUpdate,
      ),
      reminder: await verifyChannel(
        guildId,
        'reminder',
        config.channels.reminder,
      ),
    };

    guildStates.set(guildId, {
      config,
      reachable: true,
      unreachableReason: null,
      name: guild.name,
      memberCount: guild.memberCount,
      channels,
      verifiedAt: new Date(),
    });

    logger.info(
      `Connected to guild "${guild.name}" (${guildId}), approx ${guild.memberCount} members`,
    );

    for (const problem of Object.values(channels)) {
      if (problem) logger.error(`Guild ${guildId}: ${problem}`);
    }
  }
};

const registerHandlers = () => {
  if (handlersRegistered) return;
  handlersRegistered = true;

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);

    // Fetch and verify every configured server before any sync work. This is
    // where a swapped channel configuration is caught.
    await verifyConfiguredGuilds();

    const ready = getReadyGuilds();

    if (ready.length === 0) {
      logger.error(
        'No configured guild could be reached; skipping member sync entirely. ' +
          'Confirm DISCORD_GUILD_IDS is correct and that the bot has been invited to those servers. ' +
          'The HTTP API continues to serve requests.',
      );
      return;
    }

    for (const config of ready) {
      const guild = await fetchGuild(config.guildId);
      if (!guild) continue;

      // Deliberately not awaited: a ~5,000 member fetch takes tens of seconds
      // and must not hold up the other servers or anything else.
      void syncGuildMembers(guild);
    }
  });

  client.on(Events.GuildMemberAdd, (member) => {
    if (!getGuildConfig(member.guild.id)) return;
    void handleGuildMemberAdd(member);
  });

  client.on(Events.GuildMemberRemove, (member) => {
    if (!getGuildConfig(member.guild.id)) return;
    void handleGuildMemberRemove(member);
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (!getGuildConfig(newMember.guild.id)) return;
    void handleGuildMemberUpdate(oldMember, newMember);
  });

  // A handle change is an ACCOUNT-level fact, so it is applied to that
  // account's record in every configured server that holds one — not just the
  // first. `resolveGuildMember` is passed per server so each write carries the
  // right server's ID.
  client.on(Events.UserUpdate, (oldUser, newUser) => {
    void handleUserUpdate(oldUser, newUser, getConfiguredGuilds, resolveGuildMember);
  });

  // Registered structurally rather than checked inside the handler: without
  // MessageContent every message arrives with empty content, so listening
  // would be pure noise.
  //
  // ONE listener for every server. The channel to compare against is resolved
  // inside the handler from the guild the message came from, so a message is
  // ingested only when it lands in ITS OWN server's daily-update channel.
  if (ingestionEnabled && activeConfig) {
    client.on(Events.MessageCreate, (message) => {
      void handleMessageCreate(message);
    });

    logger.info(
      `Daily-update ingestion listening across ${activeConfig.guilds.length} configured server(s)`,
    );
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
