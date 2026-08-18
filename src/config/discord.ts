import { z } from 'zod';

/**
 * Discord configuration for one or many servers.
 *
 * The program runs out of N identical Discord servers — same channel names,
 * same daily cycle, mostly disjoint member populations. Everything downstream
 * therefore consumes a *list* of servers; there is deliberately no accessor
 * that returns "the guild", because a single-guild accessor is how a feature
 * silently starts serving one server and ignoring the rest.
 *
 * A one-server deployment is the one-element case of the same list, not a
 * separate mode, so nothing branches on how many servers are configured.
 */

/** Discord snowflake: numeric string, 17-20 digits. */
const snowflakeSchema = z
  .string()
  .trim()
  .regex(/^\d{17,20}$/);

const isSnowflake = (value: string): boolean =>
  snowflakeSchema.safeParse(value).success;

export type TGuildChannels = {
  attendance: string;
  dailyUpdate: string;
  reminder: string;
};

export type TGuildConfig = {
  guildId: string;
  /**
   * Display only, and deliberately never persisted: a label is a config string,
   * and storing it would create a second copy that goes stale the moment `.env`
   * changes. Falls back to the live guild name, then to the ID.
   */
  label: string | null;
  channels: TGuildChannels;
};

export type TDiscordConfig = {
  botToken: string;
  guilds: TGuildConfig[];
};

/**
 * True when a bot token is present. Startup uses this to skip the bot entirely
 * (rather than fail) in environments that intentionally run API-only.
 */
export const isDiscordConfigured = (): boolean =>
  Boolean(process.env.DISCORD_BOT_TOKEN?.trim());

/**
 * Splits a comma-separated list into positional entries.
 *
 * Trailing empties are dropped, because `111,222,` is a harmless typo. Interior
 * empties are NOT dropped: `111,,222` must stay three entries so the length
 * check and the per-position error can catch it. Silently compacting it would
 * shift every later entry onto the wrong server — exactly the misalignment this
 * whole validation exists to prevent.
 */
const splitList = (value: string | undefined): string[] => {
  if (!value?.trim()) return [];

  const entries = value.split(',').map((entry) => entry.trim());

  while (entries.length > 0 && entries[entries.length - 1] === '') {
    entries.pop();
  }

  return entries;
};

/**
 * Reads a positional list, falling back to the singular variable so an existing
 * single-server `.env` boots unchanged.
 */
const readList = (
  pluralValue: string | undefined,
  singularValue: string | undefined,
): string[] => {
  const plural = splitList(pluralValue);

  if (plural.length > 0) return plural;

  const singular = singularValue?.trim();

  return singular ? [singular] : [];
};

type TListSpec = {
  /** The environment variable name, for error messages. */
  name: string;
  entries: string[];
};

/** Validates every entry's shape, naming the variable and the 1-based position. */
const collectShapeErrors = ({ name, entries }: TListSpec): string[] =>
  entries.flatMap((entry, index) => {
    const position = index + 1;

    if (entry === '') {
      return [
        `${name}: entry ${position} is empty. The lists are positional, so an empty entry would shift every later entry onto the wrong server.`,
      ];
    }

    if (!isSnowflake(entry)) {
      return [
        `${name}: entry ${position} ("${entry}") must be a Discord snowflake ID (17-20 digits). Enable Developer Mode in Discord, then right-click the guild or channel and choose "Copy ID".`,
      ];
    }

    return [];
  });

/**
 * Cross-list checks.
 *
 * These catch a length mismatch, a repeated guild, and a channel reused across
 * servers. They deliberately CANNOT catch a swapped pair — two servers holding
 * each other's channel IDs passes every check here, because the lists are the
 * same length and every entry is a distinct well-formed snowflake. Since the
 * servers name their channels identically, that mistake is also invisible to a
 * human reading this file or Discord. It is caught at runtime instead, by the
 * channel-ownership verification in `src/lib/discord/client.ts`, which is the
 * only check that can see it.
 */
const collectCrossListErrors = (
  guilds: TListSpec,
  channelLists: TListSpec[],
): string[] => {
  const errors: string[] = [];

  for (const list of channelLists) {
    if (list.entries.length !== guilds.entries.length) {
      errors.push(
        `${list.name} has ${list.entries.length} entr${list.entries.length === 1 ? 'y' : 'ies'} but ${guilds.name} has ${guilds.entries.length}. ` +
          'The lists are positional: entry N of every list must describe the same server.',
      );
    }
  }

  const seenGuilds = new Map<string, number>();

  guilds.entries.forEach((guildId, index) => {
    const first = seenGuilds.get(guildId);

    if (first !== undefined) {
      errors.push(
        `${guilds.name}: guild ${guildId} appears at entries ${first + 1} and ${index + 1}. Each server must be listed once.`,
      );
      return;
    }

    seenGuilds.set(guildId, index);
  });

  // A channel ID under two servers would post one server's messages twice into
  // a single channel and never into the other, while looking entirely healthy.
  const seenChannels = new Map<string, string>();

  for (const list of channelLists) {
    list.entries.forEach((channelId, index) => {
      if (channelId === '' || !isSnowflake(channelId)) return;

      const where = `${list.name} entry ${index + 1}`;
      const first = seenChannels.get(channelId);

      if (first !== undefined) {
        errors.push(
          `Channel ${channelId} is configured twice (${first} and ${where}). ` +
            'One channel cannot serve two servers; check the lists line up.',
        );
        return;
      }

      seenChannels.set(channelId, where);
    });
  }

  return errors;
};

/**
 * Reads entry `index` of a list.
 *
 * Safe by construction: this is only reached after `collectCrossListErrors`
 * confirmed every list is the same length as the guild list and returned early
 * otherwise, so the entry always exists. The cast keeps that guarantee in one
 * place instead of scattering non-null assertions through the mapping below.
 */
const entryAt = (list: TListSpec, index: number): string =>
  list.entries[index] as string;

/**
 * Validates every Discord environment variable at once.
 * Returns the typed config, or the list of problems naming each offending
 * variable so startup can report exactly what to fix.
 */
export const loadDiscordConfig = ():
  | { success: true; config: TDiscordConfig }
  | { success: false; errors: string[] } => {
  const errors: string[] = [];

  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();

  if (!botToken) {
    errors.push('DISCORD_BOT_TOKEN is required and must not be empty');
  }

  const guilds: TListSpec = {
    name: 'DISCORD_GUILD_IDS',
    entries: readList(
      process.env.DISCORD_GUILD_IDS,
      process.env.DISCORD_GUILD_ID,
    ),
  };

  const attendance: TListSpec = {
    name: 'ATTENDANCE_CHANNEL_IDS',
    entries: readList(
      process.env.ATTENDANCE_CHANNEL_IDS,
      process.env.ATTENDANCE_CHANNEL_ID,
    ),
  };

  const dailyUpdate: TListSpec = {
    name: 'DAILY_UPDATE_CHANNEL_IDS',
    entries: readList(
      process.env.DAILY_UPDATE_CHANNEL_IDS,
      process.env.DAILY_UPDATE_CHANNEL_ID,
    ),
  };

  const reminder: TListSpec = {
    name: 'REMINDER_CHANNEL_IDS',
    entries: readList(
      process.env.REMINDER_CHANNEL_IDS,
      process.env.REMINDER_CHANNEL_ID,
    ),
  };

  const channelLists = [attendance, dailyUpdate, reminder];

  if (guilds.entries.length === 0) {
    errors.push(
      'DISCORD_GUILD_IDS is required (or the legacy DISCORD_GUILD_ID for a single server)',
    );
  }

  for (const list of [guilds, ...channelLists]) {
    errors.push(...collectShapeErrors(list));
  }

  errors.push(...collectCrossListErrors(guilds, channelLists));

  if (errors.length > 0) return { success: false, errors };

  const labels = splitList(process.env.DISCORD_GUILD_LABELS);

  const configuredGuilds: TGuildConfig[] = guilds.entries.map(
    (guildId, index) => ({
      guildId,
      label: labels[index]?.trim() || null,
      channels: {
        attendance: entryAt(attendance, index),
        dailyUpdate: entryAt(dailyUpdate, index),
        reminder: entryAt(reminder, index),
      },
    }),
  );

  return {
    success: true,
    // botToken is non-null here: an empty one is an error above.
    config: { botToken: botToken as string, guilds: configuredGuilds },
  };
};
