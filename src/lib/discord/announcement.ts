import { ChannelType, DiscordAPIError, type TextChannel } from 'discord.js';

import type { TGuildConfig } from '@/config/discord';
import {
  fetchGuild,
  getDiscordClient,
  isDiscordConnected,
} from '@/lib/discord/client';
import { memberRepository } from '@/repositories/member.repository';
import { createLogger } from '@/utils/logger';

const logger = createLogger('AttendanceAnnouncement');

/**
 * The only module that writes to the attendance channel.
 *
 * Both of its callers are outside a request — a `node-cron` callback and the
 * dispatch orchestrator — so nothing here throws: every outcome, Discord's
 * refusals included, comes back as a value. No `AppError` and no HTTP status
 * code appears in this file, for the same reason none appears in `dm.ts` or
 * `channel.state.ts`.
 *
 * Keeping the send here is what makes the `allowedMentions` guarantee below a
 * single place to audit rather than something to grep for.
 */

/** Discord error codes this module distinguishes. */
const DISCORD_ERROR = {
  /** Missing Access — the bot cannot see the channel. */
  MISSING_ACCESS: 50001,
  /** Missing Permissions — on this channel, that means Send Messages. */
  MISSING_PERMISSIONS: 50013,
} as const;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The configured attendance channel, or `null`.
 *
 * Resolved by ID from that server's configured channel — never by name, per the
 * rule that no logic keys off a channel's name. The guild check keeps a mistyped
 * or swapped ID from posting a mass-mention into some other server's channel —
 * which, since every server names this channel identically, would otherwise look
 * entirely correct in the logs.
 */
export const resolveAttendanceChannel = async (
  guild: TGuildConfig,
): Promise<TextChannel | null> => {
  if (!isDiscordConnected()) {
    logger.error('Discord bot is not connected; cannot resolve the channel.');
    return null;
  }

  const channelId = guild.channels.attendance;

  try {
    const channel = await getDiscordClient().channels.fetch(channelId);

    if (!channel || channel.type !== ChannelType.GuildText) {
      logger.error(
        `Attendance channel ${channelId} for guild ${guild.guildId} is not a text channel.`,
      );
      return null;
    }

    if (channel.guild.id !== guild.guildId) {
      logger.error(
        `Attendance channel ${channelId} belongs to guild ${channel.guild.id}, not the configured ${guild.guildId}.`,
      );
      return null;
    }

    return channel;
  } catch (error) {
    logger.error(
      `Could not fetch attendance channel ${channelId} for guild ${guild.guildId}:`,
      describeError(error),
    );
    return null;
  }
};

export type TResolvedMentions = {
  roleIds: string[];
  userIds: string[];
  /**
   * Allowlist entries that no longer point at anything — a deleted role, a
   * member who left. Recorded on the send, never a reason to withhold the
   * message: a missing ping is worth far less than the announcement itself.
   */
  unresolved: string[];
};

/**
 * Turns the stored allowlist into the IDs Discord will accept.
 *
 * Resolution happens here, at post time, rather than on save: a member can leave
 * and a role can be deleted in the hours between an admin saving the template
 * and 7 PM. Shape is still validated on save so obvious typos fail where
 * somebody is watching.
 *
 * Handles go through `memberRepository.findActiveMemberByUsername` — the same
 * normalized, exact-match, `isInGuild: true` lookup the attendance form uses, so
 * "who counts as a member" has one definition in this system rather than two.
 *
 * Never throws. A failure to read the guild's roles degrades to "no roles
 * resolved", which posts the message without those pings.
 */
export const resolveMentionTargets = async (
  guildConfig: TGuildConfig,
  {
    roleIds,
    usernames,
  }: {
    roleIds: string[];
    usernames: string[];
  },
): Promise<TResolvedMentions> => {
  const resolvedRoleIds: string[] = [];
  const resolvedUserIds: string[] = [];
  const unresolved: string[] = [];

  if (roleIds.length > 0) {
    const guild = await fetchGuild(guildConfig.guildId);

    if (!guild) {
      logger.error(
        `The guild could not be read, so ${roleIds.length} role mention(s) were dropped from this announcement.`,
      );
      unresolved.push(...roleIds.map((id) => `role:${id}`));
    } else {
      for (const roleId of roleIds) {
        try {
          const role = await guild.roles.fetch(roleId);

          if (role) {
            resolvedRoleIds.push(role.id);
          } else {
            unresolved.push(`role:${roleId}`);
          }
        } catch (error) {
          logger.error(
            `Could not resolve role ${roleId}:`,
            describeError(error),
          );
          unresolved.push(`role:${roleId}`);
        }
      }
    }
  }

  for (const username of usernames) {
    try {
      // Resolved WITHIN this server. A handle that belongs to the other server
      // only is genuinely unresolvable here — mentioning them would not notify
      // anyone in this channel — so it is recorded as unresolved for this
      // server and the message still goes out.
      const members =
        await memberRepository.findActiveMembersByUsername(username);
      const member = members.find(
        (candidate) => candidate.guildId === guildConfig.guildId,
      );

      if (member) {
        resolvedUserIds.push(member.discordUserId);
      } else {
        unresolved.push(`user:${username}`);
      }
    } catch (error) {
      logger.error(
        `Could not resolve member handle ${username}:`,
        describeError(error),
      );
      unresolved.push(`user:${username}`);
    }
  }

  if (unresolved.length > 0) {
    logger.warn(
      `${unresolved.length} mention target(s) did not resolve and were dropped from this announcement: ${unresolved.join(', ')}`,
    );
  }

  return {
    roleIds: resolvedRoleIds,
    userIds: resolvedUserIds,
    unresolved,
  };
};

export type TAnnouncementPostResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; missingPermission: boolean };

export type TPostAnnouncementInput = {
  content: string;
  mentions: {
    everyone: boolean;
    roleIds: string[];
    userIds: string[];
  };
  /**
   * Deduplication key for this exact post, max 25 characters (Discord's limit
   * on `nonce`). Must be derived from the claim — the date and attempt — so
   * every HTTP attempt at delivering one logical announcement carries the same
   * value. See the `enforceNonce` note on `postAttendanceAnnouncement`.
   */
  nonce: string;
};

/** Discord's limit on the `nonce` field. */
const MAX_NONCE_LENGTH = 25;

/**
 * Posts the announcement.
 *
 * ── Plain content, never an embed ─────────────────────────────────────────
 * The open/lock notices are embeds; this one cannot be. **Mentions inside an
 * embed do not notify anybody** — Discord resolves pings only in `content`. Half
 * of what this feature exists for is reaching the roles that need to see the
 * message, so the body goes out as plain text, exactly as an admin typed it.
 *
 * ── allowedMentions ───────────────────────────────────────────────────────
 * `parse` is empty unless the template's `@everyone` flag is explicitly on, and
 * the roles and users are the resolved allowlist and nothing else. Discord
 * notifies only what this object names, so mention text typed into the body —
 * a pasted `@everyone`, a copied role ping — is inert no matter what the message
 * says. A bug that pings ~5,000 students at 7 PM is not one you get to fix
 * quietly, and this is the one-line guarantee that it cannot happen by accident.
 *
 * ── enforceNonce ──────────────────────────────────────────────────────────
 * The database claim in `announcement.dispatch.ts` guarantees this function is
 * *called* once a day. It cannot guarantee one message: discord.js's REST layer
 * retries a request that times out, and a POST that Discord already processed
 * but whose response never arrived is indistinguishable from one it never saw.
 * Each retry then creates another identical message, and only the last response
 * carries a message ID back — so the log records one post and the channel shows
 * several. Observed exactly that way, four messages from one send.
 *
 * `enforceNonce: true` with a deterministic `nonce` closes it at the only layer
 * that can: Discord itself checks the nonce against recent messages from the
 * same author and returns the existing message instead of creating a second.
 * The two mechanisms cover different windows and neither replaces the other —
 * the nonce covers the seconds of one HTTP call's retries, the claim covers the
 * day.
 */
export const postAttendanceAnnouncement = async (
  guild: TGuildConfig,
  { content, mentions, nonce }: TPostAnnouncementInput,
): Promise<TAnnouncementPostResult> => {
  const channel = await resolveAttendanceChannel(guild);

  if (!channel) {
    return {
      ok: false,
      error: `The attendance channel for guild ${guild.guildId} could not be resolved.`,
      missingPermission: false,
    };
  }

  try {
    const message = await channel.send({
      content,
      allowedMentions: {
        parse: mentions.everyone ? ['everyone'] : [],
        roles: mentions.roleIds,
        users: mentions.userIds,
      },
      nonce: nonce.slice(0, MAX_NONCE_LENGTH),
      enforceNonce: true,
    });

    logger.info(
      `Announcement posted to channel ${channel.id} as message ${message.id} ` +
        `(nonce: ${nonce}, everyone: ${mentions.everyone}, roles: ${mentions.roleIds.length}, users: ${mentions.userIds.length}).`,
    );

    return { ok: true, messageId: message.id };
  } catch (error) {
    const missingPermission =
      error instanceof DiscordAPIError &&
      (error.code === DISCORD_ERROR.MISSING_PERMISSIONS ||
        error.code === DISCORD_ERROR.MISSING_ACCESS);

    if (missingPermission) {
      logger.error(
        `Announcement rejected: the bot needs "Send Messages" on #${channel.name} (${channel.id}). ` +
          'Until it is granted, the evening announcement is never posted and the channel simply goes quiet.',
      );
    } else {
      logger.error(
        'Failed to post the attendance announcement:',
        describeError(error),
      );
    }

    return { ok: false, error: describeError(error), missingPermission };
  }
};

/** One server's configured channel ID, for status payloads. */
export const getAttendanceChannelId = (guild: TGuildConfig): string =>
  guild.channels.attendance;
