import {
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  PermissionFlagsBits,
  type TextChannel,
} from 'discord.js';

import {
  getDiscordClient,
  getDiscordConfig,
  isDiscordConnected,
} from '@/lib/discord/client';
import { channelScheduleRepository } from '@/repositories/channelSchedule.repository';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ChannelState');

/**
 * The only module that changes the daily-update channel's permissions.
 *
 * Three things drive the channel — the scheduled jobs, the boot reconcile, and
 * the admin's manual override — and all three come through here. A second path
 * that edits the overwrite slightly differently is how "the channel says it is
 * open but nobody can post" happens.
 *
 * Nothing here throws. Its callers are a cron callback with no request to fail
 * and a service that turns a returned failure into an `AppError` itself, so
 * every outcome is reported as a value.
 */

/** Discord's "Missing Permissions" — almost always Manage Roles on the channel. */
const MISSING_PERMISSIONS_CODE = 50013;

export type TChannelOperationResult =
  | { ok: true; announced: boolean }
  | { ok: false; error: string; missingPermission: boolean };

const isMissingPermissions = (error: unknown): boolean =>
  error instanceof DiscordAPIError && error.code === MISSING_PERMISSIONS_CODE;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The configured daily-update channel, or `null`.
 *
 * Resolved by ID from `DAILY_UPDATE_CHANNEL_ID` — never by name, per the rule
 * that no logic keys off a channel's name. The guild check keeps a mistyped ID
 * pointing at some other server's channel from being edited.
 */
const resolveDailyUpdateChannel = async (): Promise<TextChannel | null> => {
  const config = getDiscordConfig();

  if (!config) {
    logger.error('Discord is not configured; cannot resolve the channel.');
    return null;
  }

  if (!isDiscordConnected()) {
    logger.error('Discord bot is not connected; cannot resolve the channel.');
    return null;
  }

  const channelId = config.channels.dailyUpdate;

  try {
    const channel = await getDiscordClient().channels.fetch(channelId);

    if (!channel || channel.type !== ChannelType.GuildText) {
      logger.error(
        `DAILY_UPDATE_CHANNEL_ID ${channelId} is not a text channel in this server.`,
      );
      return null;
    }

    if (channel.guild.id !== config.guildId) {
      logger.error(
        `DAILY_UPDATE_CHANNEL_ID ${channelId} belongs to guild ${channel.guild.id}, not the configured ${config.guildId}.`,
      );
      return null;
    }

    return channel;
  } catch (error) {
    logger.error(
      `Could not fetch daily-update channel ${channelId}:`,
      describeError(error),
    );
    return null;
  }
};

/** `18:00` → `6:00 PM`, for announcement copy only. */
const formatTimeLabel = (time: string): string => {
  const [hourText, minute] = time.split(':');
  const hour = Number(hourText);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;

  return `${displayHour}:${minute} ${suffix}`;
};

/**
 * Announcement copy, built from the stored schedule rather than fixed strings:
 * an admin who moves the lock to 10:00 PM must not have the embed keep telling
 * students they have until 11:59.
 */
const buildAnnouncementEmbed = async (open: boolean): Promise<EmbedBuilder> => {
  const { openTime, closeTime } =
    await channelScheduleRepository.getOrCreateSchedule();

  return open
    ? new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('🟢 Daily Update Channel is OPEN')
        .setDescription(
          `Please submit your daily learning update before **${formatTimeLabel(closeTime)}** tonight.`,
        )
        .setTimestamp()
    : new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🔴 Daily Update Channel is CLOSED')
        .setDescription(
          `Submission time is over for today. The channel reopens at **${formatTimeLabel(openTime)}**.`,
        )
        .setTimestamp();
};

/**
 * Opens or locks the channel for `@everyone`.
 *
 * Only `SendMessages` is touched. `ViewChannel` is deliberately left alone on
 * lock so the day's messages and the closing notice stay readable — a locked
 * channel is a read-only one, not a hidden one.
 *
 * The announcement is sent *after* the permission edit and in its own
 * try/catch: the window is what matters, and an embed that failed to send is
 * cosmetic next to a channel that never opened.
 */
export const setDailyUpdateChannelOpen = async (
  open: boolean,
  { announce }: { announce: boolean },
): Promise<TChannelOperationResult> => {
  const channel = await resolveDailyUpdateChannel();

  if (!channel) {
    return {
      ok: false,
      error: 'The daily-update channel could not be resolved.',
      missingPermission: false,
    };
  }

  try {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
      SendMessages: open,
    });
  } catch (error) {
    const message = describeError(error);

    if (isMissingPermissions(error)) {
      logger.error(
        `Missing permissions to edit channel ${channel.id}. The bot needs "Manage Roles" on #${channel.name} ` +
          'to change the @everyone SendMessages overwrite. Until it is granted, the submission window is not enforced.',
      );

      return { ok: false, error: message, missingPermission: true };
    }

    logger.error(
      `Failed to ${open ? 'open' : 'lock'} channel ${channel.id}:`,
      message,
    );

    return { ok: false, error: message, missingPermission: false };
  }

  logger.info(
    `Channel ${channel.id} is now ${open ? 'OPEN' : 'LOCKED'} for @everyone`,
  );

  if (!announce) return { ok: true, announced: false };

  try {
    const embed = await buildAnnouncementEmbed(open);
    await channel.send({ embeds: [embed] });

    return { ok: true, announced: true };
  } catch (error) {
    logger.error(
      `Channel ${open ? 'open' : 'lock'} succeeded but the announcement failed:`,
      describeError(error),
    );

    // The permission change stands. Reported as a success because the window —
    // the thing students are actually affected by — was applied.
    return { ok: true, announced: false };
  }
};

/**
 * Whether `@everyone` can currently post, or `null` when the channel could not
 * be read.
 *
 * Read live from Discord every time, never cached in a column: an admin can
 * flip the overwrite by hand in the client at any moment, and a stored flag
 * would then be confidently wrong on the dashboard and would make the boot
 * reconcile skip a correction it should have made.
 */
export const isDailyUpdateChannelOpen = async (): Promise<boolean | null> => {
  const channel = await resolveDailyUpdateChannel();

  if (!channel) return null;

  try {
    const permissions = channel.permissionsFor(channel.guild.roles.everyone);

    return permissions?.has(PermissionFlagsBits.SendMessages) ?? null;
  } catch (error) {
    logger.error(
      `Could not read permissions for channel ${channel.id}:`,
      describeError(error),
    );
    return null;
  }
};

/** The configured channel ID, for status payloads. */
export const getDailyUpdateChannelId = (): string | null =>
  getDiscordConfig()?.channels.dailyUpdate ?? null;
