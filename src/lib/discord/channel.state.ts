import {
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  PermissionFlagsBits,
  type TextChannel,
} from 'discord.js';

import type { TGuildConfig } from '@/config/discord';
import { getDiscordClient, isDiscordConnected } from '@/lib/discord/client';
import { channelScheduleRepository } from '@/repositories/channelSchedule.repository';
import { getDhakaDate, getDhakaTimeOfDay } from '@/utils/dhakaDate';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ChannelState');

/**
 * The only module that changes a daily-update channel's permissions.
 *
 * Three things drive the channel — the scheduled jobs, the boot reconcile, and
 * the admin's manual override — and all three come through here. A second path
 * that edits the overwrite slightly differently is how "the channel says it is
 * open but nobody can post" happens.
 *
 * Every function acts on ONE named server. The fan-out across servers lives in
 * the callers (`channelSchedule.scheduler.ts` and `schedule.service.ts`), not
 * here, so this module keeps exactly one job: editing one channel correctly.
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
 * One server's daily-update channel, or `null`.
 *
 * Resolved by ID from that server's configured channel — never by name, per the
 * rule that no logic keys off a channel's name. That rule matters more with
 * several servers, not less: every server names this channel identically, so a
 * name lookup could not tell them apart at all.
 *
 * The guild check is kept even though `client.ts` verifies channel ownership at
 * startup. It is cheap, it also covers a configuration reloaded after boot, and
 * it is the last line between a swapped configuration and this module editing
 * the WRONG server's permissions.
 */
const resolveDailyUpdateChannel = async (
  guild: TGuildConfig,
): Promise<TextChannel | null> => {
  if (!isDiscordConnected()) {
    logger.error('Discord bot is not connected; cannot resolve the channel.');
    return null;
  }

  const channelId = guild.channels.dailyUpdate;

  try {
    const channel = await getDiscordClient().channels.fetch(channelId);

    if (!channel || channel.type !== ChannelType.GuildText) {
      logger.error(
        `Daily-update channel ${channelId} for guild ${guild.guildId} is not a text channel.`,
      );
      return null;
    }

    if (channel.guild.id !== guild.guildId) {
      logger.error(
        `Daily-update channel ${channelId} belongs to guild ${channel.guild.id}, not the configured ${guild.guildId}. ` +
          'The channel ID lists are positional — check that entry N of every list describes the same server.',
      );
      return null;
    }

    return channel;
  } catch (error) {
    logger.error(
      `Could not fetch daily-update channel ${channelId} for guild ${guild.guildId}:`,
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
 * The deduplication key for one open/lock notice, ≤ 25 characters (Discord's
 * limit on `nonce`).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * discord.js's REST layer times a request out after 15 seconds and retries it.
 * A POST that Discord already processed but whose response never came back is
 * indistinguishable from one it never received, so every retry creates another
 * identical embed while only the last response returns a message ID. Observed
 * exactly that way on a slow connection: one click on the manual open produced
 * three "Channel is OPEN" embeds, 15.075s and 15.029s apart, and one send
 * produced two, 15.094s apart.
 *
 * `enforceNonce: true` closes it at the only layer that can — Discord matches
 * the nonce against recent messages from the same author and returns the
 * existing message instead of creating a second. Retries carry the body they
 * were built with, so a value computed once per call covers them however long
 * they take; scoping it to the action and the Dhaka MINUTE additionally
 * swallows a double-clicked button, while leaving a deliberate re-open a minute
 * later free to announce.
 *
 * The same guarantee `postAttendanceAnnouncement` relies on, for the same
 * reason. Anything else in this program that posts to a channel thousands of
 * students read needs it too.
 */
const buildNoticeNonce = (open: boolean): string =>
  `${open ? 'open' : 'lock'}-${getDhakaDate().replace(/-/g, '')}-${getDhakaTimeOfDay().replace(':', '')}`;

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
  guild: TGuildConfig,
  open: boolean,
  { announce }: { announce: boolean },
): Promise<TChannelOperationResult> => {
  const channel = await resolveDailyUpdateChannel(guild);

  if (!channel) {
    return {
      ok: false,
      error: `The daily-update channel for guild ${guild.guildId} could not be resolved.`,
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

    await channel.send({
      embeds: [embed],
      // Without these two, a timed-out POST that Discord actually processed is
      // retried into a second identical embed. See `buildNoticeNonce`.
      enforceNonce: true,
      nonce: buildNoticeNonce(open),
    });

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
export const isDailyUpdateChannelOpen = async (
  guild: TGuildConfig,
): Promise<boolean | null> => {
  const channel = await resolveDailyUpdateChannel(guild);

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

/** One server's configured channel ID, for status payloads. */
export const getDailyUpdateChannelId = (guild: TGuildConfig): string =>
  guild.channels.dailyUpdate;
