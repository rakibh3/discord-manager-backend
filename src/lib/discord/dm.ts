import { ChannelType, DiscordAPIError, type TextChannel } from 'discord.js';

import {
  getDiscordClient,
  getDiscordConfig,
  isDiscordConnected,
} from '@/lib/discord/client';
import { createLogger } from '@/utils/logger';

const logger = createLogger('ReminderDM');

/**
 * The only module that sends a direct message or writes to the reminder
 * channel.
 *
 * Its caller is a BullMQ job, which has no request to fail, so nothing here
 * throws: every outcome — including "Discord refused" — comes back as a value
 * and the worker decides what it means. There is no `AppError` and no HTTP
 * status code in this file, for the same reason there is none in the gateway
 * handlers or the scheduler.
 *
 * Keeping both outbound paths here is what makes the error-code table below a
 * single place to change when Discord adds a code, instead of something to grep
 * for across the worker and the queue.
 */

/** Discord error codes this module distinguishes. */
const DISCORD_ERROR = {
  /** Cannot send messages to this user — DMs closed, or the bot is blocked. */
  CANNOT_SEND_DM: 50007,
  /** Unknown User — the account was deleted. */
  UNKNOWN_USER: 10013,
  /** Missing Access — the bot cannot see the channel. */
  MISSING_ACCESS: 50001,
  /** Missing Permissions — on the reminder channel, that means Send Messages. */
  MISSING_PERMISSIONS: 50013,
} as const;

/**
 * What one send attempt produced.
 *
 * `retryable` is the only outcome the worker turns into a thrown error, and so
 * the only one that consumes a retry attempt. Everything else is a fact about
 * that member which a second attempt cannot change.
 */
export type TDmResult =
  | { status: 'delivered' }
  | { status: 'dm_closed' }
  | { status: 'failed'; error: string }
  | { status: 'retryable'; error: string; retryAfterMs?: number };

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Classifies a Discord failure.
 *
 * ── The table ─────────────────────────────────────────────────────────────
 *   50007  DMs closed / bot blocked  -> dm_closed  (recorded, never retried;
 *                                                   the fallback reaches them)
 *   10013  Unknown User (deleted)    -> failed     (nothing to retry against)
 *   50001  Missing Access            -> failed
 *   50013  Missing Permissions       -> failed     (a config problem, not a
 *                                                   transient one — retrying
 *                                                   three times just delays the
 *                                                   report)
 *   429    Rate limited              -> retryable, carrying Discord's retry-after
 *   5xx / network / timeout          -> retryable
 *
 * Anything unrecognised is treated as retryable. That is the safer default for
 * a reminder: three wasted attempts cost seconds, whereas mis-classifying a
 * transient blip as terminal marks a student unreachable when they were not.
 */
const classifyError = (error: unknown): TDmResult => {
  if (error instanceof DiscordAPIError) {
    switch (error.code) {
      case DISCORD_ERROR.CANNOT_SEND_DM:
        return { status: 'dm_closed' };

      case DISCORD_ERROR.UNKNOWN_USER:
        return { status: 'failed', error: 'Discord account no longer exists' };

      case DISCORD_ERROR.MISSING_ACCESS:
      case DISCORD_ERROR.MISSING_PERMISSIONS:
        return { status: 'failed', error: describeError(error) };

      default:
        break;
    }

    // 5xx from Discord is worth another attempt; other 4xx are not, because a
    // malformed request stays malformed.
    if (error.status >= 500) {
      return { status: 'retryable', error: describeError(error) };
    }

    return { status: 'failed', error: describeError(error) };
  }

  // discord.js surfaces a 429 as RateLimitError when rejectOnRateLimit is set,
  // and otherwise queues internally. If one does reach us, hand the wait back
  // to the worker so it pauses the whole queue rather than this one job.
  const retryAfter = (error as { retryAfter?: number } | null)?.retryAfter;

  if (typeof retryAfter === 'number') {
    return {
      status: 'retryable',
      error: describeError(error),
      retryAfterMs: Math.ceil(retryAfter),
    };
  }

  return { status: 'retryable', error: describeError(error) };
};

/** The fixed heading, so a recipient can tell what this DM is at a glance. */
const DM_HEADING = '⚠️ **Daily Update Reminder**';

/** Discord's hard limit on a single message. */
const DISCORD_MESSAGE_LIMIT = 2000;

/** Room the heading and its blank line take out of that limit. */
export const DM_HEADING_OVERHEAD = DM_HEADING.length + 2;

/** The largest admin message that still fits once the heading is added. */
export const MAX_REMINDER_MESSAGE_LENGTH =
  DISCORD_MESSAGE_LIMIT - DM_HEADING_OVERHEAD;

export const buildReminderDmBody = (message: string): string =>
  `${DM_HEADING}\n\n${message}`;

/**
 * Sends one reminder DM, addressed by snowflake.
 *
 * Golden Rule 1: the recipient is always resolved from `discord_user_id`. A
 * lookup by handle would deliver a private message to whoever holds a renamed
 * member's old handle.
 */
export const sendMemberDm = async (
  discordUserId: string,
  message: string,
): Promise<TDmResult> => {
  if (!isDiscordConnected()) {
    return {
      status: 'retryable',
      error: 'Discord bot is not connected',
    };
  }

  try {
    const user = await getDiscordClient().users.fetch(discordUserId);

    await user.send({ content: buildReminderDmBody(message) });

    return { status: 'delivered' };
  } catch (error) {
    return classifyError(error);
  }
};

export type TFallbackMember = {
  discordUserId: string;
  discordUsername: string;
};

export type TFallbackResult =
  | { ok: true; messagesPosted: number; mentioned: number }
  | { ok: false; error: string; missingPermission: boolean };

/**
 * Mentions per message.
 *
 * A mention is `<@` + a 17-20 digit snowflake + `>`, so 22 characters at most.
 * 50 of them is 1,100 characters, leaving well over a third of the 2,000-char
 * budget for the header. Capping by count rather than measuring the assembled
 * string keeps this from depending on how long the header happens to be today.
 */
const MENTIONS_PER_MESSAGE = 50;

/**
 * The configured reminder channel, or `null`.
 *
 * Resolved by ID from `REMINDER_CHANNEL_ID` — never by name, per the rule that
 * no logic keys off a channel's name. The guild check keeps a mistyped ID from
 * mass-mentioning members in some other server's channel.
 */
const resolveReminderChannel = async (): Promise<TextChannel | null> => {
  const config = getDiscordConfig();

  if (!config) {
    logger.error('Discord is not configured; cannot resolve the channel.');
    return null;
  }

  if (!isDiscordConnected()) {
    logger.error('Discord bot is not connected; cannot resolve the channel.');
    return null;
  }

  const channelId = config.channels.reminder;

  try {
    const channel = await getDiscordClient().channels.fetch(channelId);

    if (!channel || channel.type !== ChannelType.GuildText) {
      logger.error(
        `REMINDER_CHANNEL_ID ${channelId} is not a text channel in this server.`,
      );
      return null;
    }

    if (channel.guild.id !== config.guildId) {
      logger.error(
        `REMINDER_CHANNEL_ID ${channelId} belongs to guild ${channel.guild.id}, not the configured ${config.guildId}.`,
      );
      return null;
    }

    return channel;
  } catch (error) {
    logger.error(
      `Could not fetch reminder channel ${channelId}:`,
      describeError(error),
    );
    return null;
  }
};

/**
 * Posts the closed-DM fallback: the members a DM could not reach, mentioned in
 * `#daily-update-reminder` so they still find out.
 *
 * ── allowedMentions ───────────────────────────────────────────────────────
 * Every message sets `parse: []` alongside an explicit `users` list. `parse: []`
 * is the part that matters: it makes `@everyone`, `@here`, and role pings
 * structurally impossible from this code path, whatever ends up in the
 * surrounding text now or later. Discord resolves only what the list names.
 * A bug that pings 5,000 students at midnight is not one you get to fix
 * quietly, and this is a one-line guarantee that it cannot happen.
 */
export const announceClosedDms = async (
  members: TFallbackMember[],
): Promise<TFallbackResult> => {
  if (members.length === 0) {
    return { ok: true, messagesPosted: 0, mentioned: 0 };
  }

  const channel = await resolveReminderChannel();

  if (!channel) {
    return {
      ok: false,
      error: 'Reminder channel could not be resolved',
      missingPermission: false,
    };
  }

  let messagesPosted = 0;

  try {
    for (let i = 0; i < members.length; i += MENTIONS_PER_MESSAGE) {
      const chunk = members.slice(i, i + MENTIONS_PER_MESSAGE);
      const userIds = chunk.map((member) => member.discordUserId);
      const mentions = userIds.map((id) => `<@${id}>`).join(' ');

      const header =
        i === 0
          ? '📢 **Attention:** the following members have DMs closed, so the reminder could not be delivered privately. Please submit your daily update as soon as possible!'
          : '📢 *(continued)*';

      await channel.send({
        content: `${header}\n${mentions}`,
        allowedMentions: { parse: [], users: userIds },
      });

      messagesPosted += 1;
    }

    logger.info(
      `Fallback announcement posted: ${members.length} member(s) across ${messagesPosted} message(s).`,
    );

    return { ok: true, messagesPosted, mentioned: members.length };
  } catch (error) {
    const missingPermission =
      error instanceof DiscordAPIError &&
      (error.code === DISCORD_ERROR.MISSING_PERMISSIONS ||
        error.code === DISCORD_ERROR.MISSING_ACCESS);

    if (missingPermission) {
      logger.error(
        `Fallback announcement rejected: the bot needs "Send Messages" on the reminder channel ${channel.id}. The reminder DMs were delivered; the members with closed DMs were NOT reached.`,
      );
    } else {
      logger.error(
        'Failed to post the closed-DM fallback announcement:',
        describeError(error),
      );
    }

    return { ok: false, error: describeError(error), missingPermission };
  }
};
