import { z } from 'zod';

/**
 * `POST /api/discord/sync`
 *
 * An empty body syncs every configured server, which is the ordinary case.
 * `guildId` narrows it to one — useful when a single server's directory needs
 * repairing without paying for a full ~5,000-member fetch of the others.
 *
 * Whether the ID is actually configured is checked in the service, not here:
 * the schema cannot know the configured set, and the error has to name the
 * unknown server rather than reading as a format complaint.
 */
const triggerSyncValidationSchema = z.object({
  guildId: z
    .string({ error: 'guildId must be a string' })
    .trim()
    .regex(/^\d{17,20}$/, {
      error: 'guildId must be a Discord snowflake (17-20 digits)',
    })
    .optional(),
});

export const discordValidation = {
  triggerSyncValidationSchema,
};
