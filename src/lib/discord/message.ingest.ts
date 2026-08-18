import type { Message } from 'discord.js';

import type { TGuildConfig } from '@/config/discord';
import { mapGuildMemberToPayload } from '@/lib/discord/member.mapper';
import { upsertMemberPayload } from '@/lib/discord/member.sync';
import { dailyUpdateRepository } from '@/repositories/dailyUpdate.repository';
import { memberRepository } from '@/repositories/member.repository';
import { getDhakaDate } from '@/utils/dhakaDate';
import { createLogger } from '@/utils/logger';

const logger = createLogger('DailyUpdate');

/** The acknowledgement a student sees once their update is safely stored. */
const ACK_EMOJI = '✅';

/**
 * Resolves a message author to the `discord_members` row that owns the message,
 * repairing the directory when the author is not yet recorded.
 *
 * The initial sync of ~5,000 members is deliberately not awaited at
 * `ClientReady` and takes tens of seconds; a member can also join during a
 * gateway gap. Either way a student may post before the directory knows them,
 * and dropping that message would cost them credit for work they did. So on a
 * miss we fetch the member and write them through `upsertMemberPayload` — the
 * same path member sync uses, which carries the username-collision tombstoning
 * and the reactivate-on-rejoin behavior. A direct `discordMember.create` here
 * would be a second write path that drifts from it.
 *
 * The repair must happen before the insert: `memberId` is a required foreign
 * key. Returns `null` when the author cannot be resolved at all, which is the
 * one case where the message is dropped.
 *
 * Everything here is scoped to the server the message came from. The same
 * account may hold a record in several servers, and this message belongs to
 * exactly one of them: crediting it to another server's record would mark the
 * author present where they posted nothing and leave them missing where they
 * did post. An account known in the OTHER server but not this one is therefore
 * a miss, and gets a new record for this server rather than reusing or moving
 * the existing one.
 */
const resolveMessageAuthor = async (
  message: Message,
  guildConfig: TGuildConfig,
): Promise<string | null> => {
  const authorId = message.author.id;
  const { guildId } = guildConfig;

  const stored = await memberRepository.findMemberByDiscordUserId(
    guildId,
    authorId,
  );
  if (stored) return stored.id;

  logger.warn(
    `Author ${authorId} (${message.author.username}) has no member record in guild ${guildId}; fetching from Discord`,
  );

  // Taken from the message rather than fetched through the client, which keeps
  // this module free of an import cycle back into `client.ts`. The handler has
  // already confirmed this message came from a configured guild, and
  // `mapGuildMemberToPayload` reads the server off the member itself — so the
  // repaired row can only ever be written under the server it was fetched from.
  const { guild } = message;
  if (!guild) {
    logger.error(
      `Cannot repair directory for author ${authorId}: message ${message.id} has no guild. Message dropped.`,
    );
    return null;
  }

  try {
    const member = await guild.members.fetch(authorId);
    if (member.user.bot) return null;

    await upsertMemberPayload(mapGuildMemberToPayload(member));
  } catch (error) {
    // The member left between posting and processing, or the fetch failed.
    // There is nothing to attach the message to, and inventing a placeholder
    // member row would poison the dashboard's denominators.
    logger.error(
      `Could not fetch member ${authorId} for message ${message.id}; message dropped:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  const repaired = await memberRepository.findMemberByDiscordUserId(
    guildId,
    authorId,
  );
  if (!repaired) {
    logger.error(
      `Member ${authorId} still missing after upsert; message ${message.id} dropped`,
    );
    return null;
  }

  logger.info(
    `Directory repaired from message ingestion in guild ${guildId}: ${repaired.discordUsername} (${authorId})`,
  );

  return repaired.id;
};

/**
 * Acknowledges a stored message with ✅.
 *
 * Best-effort and deliberately after the write: the row is the source of truth
 * and a missing reaction is cosmetic, while a missing row marks a student as
 * having skipped their update. A revoked Add Reactions permission or a message
 * deleted in the same instant must not undo the ingestion.
 */
const acknowledge = async (message: Message): Promise<void> => {
  try {
    await message.react(ACK_EMOJI);
  } catch (error) {
    logger.warn(
      `Stored message ${message.id} but could not react with ${ACK_EMOJI} ` +
        '(check the bot\'s "Add Reactions" permission in #daily-update):',
      error instanceof Error ? error.message : error,
    );
  }
};

/**
 * Stores one `#daily-update` message and acknowledges it.
 *
 * Called from the `messageCreate` gateway handler, which has already resolved
 * the server and applied the channel, author, and content filters. Never
 * throws: a gateway listener has no request to fail, and an unhandled rejection
 * here would surface as a process-level warning while silently losing the
 * message.
 */
export const ingestDailyUpdateMessage = async (
  message: Message,
  guildConfig: TGuildConfig,
): Promise<void> => {
  try {
    const memberId = await resolveMessageAuthor(message, guildConfig);
    if (!memberId) return;

    // The civil date comes from when the message was SENT, never from now.
    // A message posted at 23:58 and written at 00:01 belongs to the day it was
    // sent — most likely to matter during the rush before the channel locks.
    const { created } = await dailyUpdateRepository.createDailyUpdate({
      memberId,
      discordMessageId: message.id,
      channelId: message.channelId,
      message: message.content,
      messageDate: getDhakaDate(message.createdAt),
      messageCreatedAt: message.createdAt,
    });

    if (!created) {
      // A replayed gateway event after a reconnect. The row already exists and
      // the message was already acknowledged, so do neither again.
      logger.info(`Message ${message.id} already ingested; skipping`);
      return;
    }

    await acknowledge(message);
  } catch (error) {
    logger.error(
      `Failed to ingest message ${message.id} from ${message.author.id}:`,
      error instanceof Error ? error.message : error,
    );
  }
};
