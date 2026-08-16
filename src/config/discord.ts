import { z } from 'zod';

// Discord snowflake: numeric string, 17-20 digits.
const snowflake = (variable: string) =>
  z
    .string({ error: `${variable} is required` })
    .trim()
    .regex(/^\d{17,20}$/, {
      error: `${variable} must be a Discord snowflake ID (17-20 digits). Enable Developer Mode in Discord, then right-click the guild or channel and choose "Copy ID".`,
    });

const discordEnvSchema = z.object({
  DISCORD_BOT_TOKEN: z
    .string({ error: 'DISCORD_BOT_TOKEN is required' })
    .trim()
    .min(1, { error: 'DISCORD_BOT_TOKEN must not be empty' }),
  DISCORD_GUILD_ID: snowflake('DISCORD_GUILD_ID'),
  ATTENDANCE_CHANNEL_ID: snowflake('ATTENDANCE_CHANNEL_ID'),
  DAILY_UPDATE_CHANNEL_ID: snowflake('DAILY_UPDATE_CHANNEL_ID'),
  REMINDER_CHANNEL_ID: snowflake('REMINDER_CHANNEL_ID'),
});

export type TDiscordConfig = {
  botToken: string;
  guildId: string;
  channels: {
    attendance: string;
    dailyUpdate: string;
    reminder: string;
  };
};

/**
 * True when a bot token is present. Startup uses this to skip the bot entirely
 * (rather than fail) in environments that intentionally run API-only.
 */
export const isDiscordConfigured = (): boolean =>
  Boolean(process.env.DISCORD_BOT_TOKEN?.trim());

/**
 * Validates every Discord environment variable at once.
 * Returns the typed config, or the list of problems naming each offending
 * variable so startup can report exactly what to fix.
 */
export const loadDiscordConfig = ():
  | { success: true; config: TDiscordConfig }
  | { success: false; errors: string[] } => {
  const parsed = discordEnvSchema.safeParse({
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
    ATTENDANCE_CHANNEL_ID: process.env.ATTENDANCE_CHANNEL_ID,
    DAILY_UPDATE_CHANNEL_ID: process.env.DAILY_UPDATE_CHANNEL_ID,
    REMINDER_CHANNEL_ID: process.env.REMINDER_CHANNEL_ID,
  });

  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'discord'}: ${issue.message}`,
      ),
    };
  }

  const env = parsed.data;

  return {
    success: true,
    config: {
      botToken: env.DISCORD_BOT_TOKEN,
      guildId: env.DISCORD_GUILD_ID,
      channels: {
        attendance: env.ATTENDANCE_CHANNEL_ID,
        dailyUpdate: env.DAILY_UPDATE_CHANNEL_ID,
        reminder: env.REMINDER_CHANNEL_ID,
      },
    },
  };
};
