import { type Message, MessageType } from 'discord.js';

import { ingestDailyUpdateMessage } from '@/lib/discord/message.ingest';
import { createLogger } from '@/utils/logger';

const logger = createLogger('DailyUpdate');

/**
 * Whether a message carries anything a student could mean as their update.
 *
 * Attachment-only messages count: someone who posts a screenshot of their work
 * with no caption has submitted an update, and refusing it would mark them
 * absent. `DailyUpdate.message` is a non-null column, so those store an empty
 * string.
 *
 * This also backstops the degraded-intent case. If `MessageContent` were ever
 * missing while `GuildMessages` was present, every message would arrive with
 * empty content — this filter turns that into "nothing ingested" rather than
 * thousands of blank rows that look like real submissions to the dashboard.
 */
const hasSubmittableContent = (message: Message): boolean =>
  message.content.trim().length > 0 ||
  message.attachments.size > 0 ||
  message.embeds.length > 0;

/**
 * Gateway entry point for `#daily-update` ingestion.
 *
 * Holds only the cheap filtering that needs the raw `Message`; everything past
 * these guards is `message.ingest.ts`. Never throws — the ingestion function
 * contains its own errors, and these filters cannot fail.
 *
 * @param dailyUpdateChannelId - from `DAILY_UPDATE_CHANNEL_ID`. Passed in
 * rather than read here so channel selection stays by ID, never by name.
 */
export const handleMessageCreate = async (
  message: Message,
  dailyUpdateChannelId: string,
  configuredGuildId: string,
): Promise<void> => {
  // A DM to the bot, or a message from some other guild it was added to.
  if (!message.guildId || message.guildId !== configuredGuildId) return;

  if (message.channelId !== dailyUpdateChannelId) return;

  // Bots include this bot: Phase 5's channel open/close embeds post into this
  // very channel and must never be recorded as a student's update.
  if (message.author.bot) return;

  // Pin notices, join announcements, and the rest of Discord's own chatter.
  if (
    message.type !== MessageType.Default &&
    message.type !== MessageType.Reply
  )
    return;

  if (!hasSubmittableContent(message)) {
    logger.info(
      `Ignoring empty message ${message.id} from ${message.author.id}`,
    );
    return;
  }

  await ingestDailyUpdateMessage(message);
};
