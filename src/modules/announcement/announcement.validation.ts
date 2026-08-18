import { z } from 'zod';

import { timeOfDaySchema } from '@/utils/dhakaDate';
import {
  DISCORD_USERNAME_REGEX,
  normalizeDiscordUsername,
} from '@/utils/discordUsername';

/**
 * Field rules for the attendance announcement.
 *
 * Two kinds of mistake are caught here rather than at 7 PM. A misspelled
 * placeholder would otherwise reach the whole program as a literal
 * `{{attendance_link}}` in the middle of the message; a malformed time would
 * produce a cron job that simply never fires, whose only symptom is a channel
 * that quietly stops being announced in.
 *
 * The rendered-length check is NOT here. A partial update supplies only some
 * fields, and the rendered length depends on the merged row plus the resolved
 * mention line — so it can only be judged in the service, which has both.
 */

const weekdaySchema = z
  .number({ error: 'Each weekday must be a number' })
  .int({ error: 'Each weekday must be a whole number' })
  .min(0, { error: 'Weekdays run from 0 (Sunday) to 6 (Saturday)' })
  .max(6, { error: 'Weekdays run from 0 (Sunday) to 6 (Saturday)' });

/**
 * The message body: text, and not empty or whitespace-only.
 *
 * The unsupported-placeholder check is deliberately NOT here, even though it is
 * a pure function of the body and would fit. `handleZodValidationError`
 * title-cases every word of every Zod message, so `{{close_time}}` would reach
 * the admin as `{{Close_time}}` — and this particular message exists to tell
 * them the exact token to type. A list of placeholder names that are subtly
 * wrong is worse than no list. The check lives in the service, where an
 * `AppError` message survives verbatim.
 */
const bodySchema = z
  .string({ error: 'The message body must be text' })
  .trim()
  .min(1, { error: 'The message body must not be empty' });

/**
 * A Discord snowflake, the same 17-20 digit shape the config validates.
 *
 * Whether the role still exists is settled at post time, not here: a role can be
 * deleted between the save and the run, and an unresolved target is dropped from
 * that post rather than blocking it.
 */
const roleIdSchema = z
  .string({ error: 'Each role ID must be text' })
  .trim()
  .regex(/^\d{17,20}$/, {
    error:
      'Each role ID must be a Discord snowflake (17-20 digits). Enable Developer Mode in Discord, then right-click the role and choose "Copy ID".',
  });

/**
 * A Discord handle, normalized before validation exactly as the attendance form
 * normalizes one, so `@Rakib ` and `rakib` are judged as the same handle.
 *
 * The transform is for the check only. `validateRequest` does not assign the
 * parsed result back onto `req.body`, so the service normalizes again before
 * storing — the same division of labour the attendance module uses, and the
 * reason the stored value can be matched exactly against `discord_members`.
 */
const usernameSchema = z
  .string({ error: 'Each username must be text' })
  .transform(normalizeDiscordUsername)
  .refine((value) => DISCORD_USERNAME_REGEX.test(value), {
    error:
      'Enter a valid Discord username: 2-32 characters using lowercase letters, numbers, underscores or periods',
  });

const uniqueArray = <T extends z.ZodTypeAny>(schema: T, label: string) =>
  z.array(schema).refine((values) => new Set(values).size === values.length, {
    error: `Each ${label} may be listed only once`,
  });

/**
 * `PATCH /api/announcement/attendance`
 *
 * Every field optional — this is a patch — but an entirely empty body is
 * rejected, since it is always a client bug rather than a no-op someone meant.
 *
 * `timezone` is deliberately absent, and Zod strips unknown keys, so a client
 * that sends one is ignored rather than refused: the zone is fixed at
 * Asia/Dhaka and is reported, never accepted.
 *
 * An empty `mentionRoleIds` or `mentionUsernames` IS allowed — that is how an
 * admin clears the allowlist. An empty `daysOfWeek` is not: pausing is what
 * `enabled: false` is for.
 */
const updateAnnouncementValidationSchema = z
  .object({
    body: bodySchema.optional(),
    terminationDays: z
      .number({ error: 'The termination threshold must be a number' })
      .int({ error: 'The termination threshold must be a whole number' })
      .min(1, { error: 'The termination threshold must be at least 1 day' })
      .max(365, { error: 'The termination threshold must be at most 365 days' })
      .optional(),
    mentionEveryone: z.boolean().optional(),
    mentionRoleIds: uniqueArray(roleIdSchema, 'role').optional(),
    mentionUsernames: uniqueArray(usernameSchema, 'username').optional(),
    announceTime: timeOfDaySchema.optional(),
    daysOfWeek: uniqueArray(weekdaySchema, 'weekday')
      .refine((days) => days.length > 0, {
        error:
          'Select at least one weekday. To pause the announcement without losing it, set enabled to false instead.',
      })
      .optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error:
      'Provide at least one of body, terminationDays, mentionEveryone, mentionRoleIds, mentionUsernames, announceTime, daysOfWeek, or enabled',
  });

/**
 * `POST /api/announcement/attendance/preview`
 *
 * Renders an unsaved body against today's live values without storing anything,
 * so a change can be read in full before it reaches a channel thousands of
 * students see. Everything is optional: with no body it previews what is stored.
 */
const previewAnnouncementValidationSchema = z.object({
  body: bodySchema.optional(),
  terminationDays: z
    .number({ error: 'The termination threshold must be a number' })
    .int({ error: 'The termination threshold must be a whole number' })
    .min(1, { error: 'The termination threshold must be at least 1 day' })
    .max(365, { error: 'The termination threshold must be at most 365 days' })
    .optional(),
});

/**
 * `POST /api/announcement/attendance/send`
 *
 * `force` is the deliberate second post. It defaults to false so a double-click
 * gets a 409 rather than a second mass-mention.
 */
const sendAnnouncementValidationSchema = z.object({
  force: z.boolean().optional(),
  /**
   * Restrict the send to named servers. Omitted means every configured server
   * with a verified attendance channel. Each named server is still subject to
   * its own once-per-day claim.
   */
  guildIds: z
    .array(
      z
        .string({ error: 'Each server ID must be a string' })
        .trim()
        .regex(/^\d{17,20}$/, {
          error: 'Each server ID must be a Discord snowflake (17-20 digits)',
        }),
    )
    .min(1, {
      error:
        'Provide at least one server ID, or omit guildIds entirely to post to every configured server',
    })
    .optional(),
});

export const announcementValidation = {
  updateAnnouncementValidationSchema,
  previewAnnouncementValidationSchema,
  sendAnnouncementValidationSchema,
};
