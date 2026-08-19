import { z } from 'zod';

import { timeOfDaySchema } from '@/utils/dhakaDate';

/**
 * Field rules for the channel schedule.
 *
 * These are the guard between an admin's time picker and a cron expression.
 * A malformed time does not fail loudly at runtime — it produces a job that
 * simply never fires, so the channel silently stops opening and the only signal
 * is students asking why they cannot post. Everything that can be caught here
 * is caught here.
 *
 * Note that the cross-field rule (close after open) is NOT expressed in this
 * schema: a partial update supplies only some fields, so coherence can only be
 * judged against the stored row. That check lives in the service, which has it.
 */

const weekdaySchema = z
  .number({ error: 'Each weekday must be a number' })
  .int({ error: 'Each weekday must be a whole number' })
  .min(0, { error: 'Weekdays run from 0 (Sunday) to 6 (Saturday)' })
  .max(6, { error: 'Weekdays run from 0 (Sunday) to 6 (Saturday)' });

/**
 * `PATCH /api/schedule/daily-update`
 *
 * Every field optional — this is a patch — but an entirely empty body is
 * rejected, since it is always a client bug rather than a no-op someone meant.
 *
 * `timezone` is deliberately absent. Zod strips unknown keys by default, so a
 * client that sends one is ignored rather than refused: the zone is fixed at
 * Asia/Dhaka and is reported, never accepted.
 *
 * `openTime` is the opposite case, and is present for exactly that reason. It
 * is no longer settable here — it mirrors the announcement time — but being
 * stripped is the wrong answer for a field a client has good reason to still be
 * sending: the save would report success while the open time ignored it. Kept
 * in the schema so it survives parsing and reaches the service, which refuses
 * it with a message naming the endpoint that does own it. The refusal is an
 * `AppError` rather than a Zod issue because `handleZodValidationError`
 * title-cases every word, and this message contains a URL path.
 */
const updateScheduleValidationSchema = z
  .object({
    openTime: timeOfDaySchema.optional(),
    closeTime: timeOfDaySchema.optional(),
    daysOfWeek: z
      .array(weekdaySchema)
      .min(1, {
        error:
          'Select at least one weekday. To pause the schedule without losing it, set enabled to false instead.',
      })
      .refine((days) => new Set(days).size === days.length, {
        error: 'Each weekday may be selected only once',
      })
      .optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: 'Provide at least one of closeTime, daysOfWeek, or enabled',
  });

/**
 * `POST /api/schedule/daily-update/open` and `/lock`.
 *
 * An empty body means every configured server, which is the ordinary case: one
 * action applies everywhere. `guildIds` narrows it, for recovering a single
 * server whose permission was fixed after the others already moved.
 *
 * Whether a named ID is actually configured is checked in the service, not
 * here — the schema cannot know the configured set, and the error must name the
 * unknown server rather than reading as a format complaint.
 */
const channelStateValidationSchema = z.object({
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
        'Provide at least one server ID, or omit guildIds entirely to act on every configured server',
    })
    .optional(),
});

export const scheduleValidation = {
  updateScheduleValidationSchema,
  channelStateValidationSchema,
};
