import { ReminderDeliveryStatus } from '@generated/prisma/enums';
import { z } from 'zod';

import { MAX_REMINDER_MESSAGE_LENGTH } from '@/lib/discord/dm';
import { dhakaDateSchema, getDhakaDate } from '@/utils/dhakaDate';

/**
 * Field rules for reminder broadcasts.
 *
 * The stakes here are not the usual validation stakes: a request that passes
 * this schema sends a private message to thousands of people and cannot be
 * undone. Everything that can be caught before that happens is caught here.
 */

/**
 * The date being reminded about.
 *
 * REQUIRED, and deliberately never defaulted. The run happens just after
 * midnight, where "yesterday" is almost always what was meant — but "almost
 * always" spanning a midnight boundary, on an irreversible mass DM, is a bad
 * trade. An admin who clicks at 11:58 PM with an inferred date would remind the
 * wrong day's stragglers and nothing about the result would look wrong. The
 * dashboard always knows which date it is displaying, so it passes it.
 *
 * A future date is refused because there is nothing to be missing yet: the day
 * has not happened, so every member would be a target.
 */
const reminderDateSchema = dhakaDateSchema.pipe(
  // `.pipe` rather than a second `.refine`, so the future check only runs once
  // the value is a real date. Chained refinements all run, which made a
  // malformed `2026-13-45` report both "not a valid calendar date" AND "cannot
  // be in the future" — two messages for one mistake, one of them nonsense.
  z.string().refine((date) => date <= getDhakaDate(), {
    error:
      'Date cannot be in the future — there is nothing to remind about yet',
  }),
);

/**
 * `POST /api/reminders/send`
 *
 * The message cap leaves room for the fixed heading the DM is wrapped in, so a
 * message that validates here always fits in one Discord message. Discovering
 * the overflow at send time would mean a broadcast that fails for every single
 * recipient, one rate-limited job at a time.
 */
const sendReminderValidationSchema = z.object({
  date: reminderDateSchema,
  message: z
    .string({ error: 'A reminder message is required' })
    .trim()
    .min(1, { error: 'The reminder message cannot be empty' })
    .max(MAX_REMINDER_MESSAGE_LENGTH, {
      error: `The reminder message must be ${MAX_REMINDER_MESSAGE_LENGTH} characters or fewer, so it fits in one Discord message alongside the reminder heading`,
    }),
});

/** `GET /api/reminders/targets?date=` — the preview, before anything is sent. */
const targetsQueryValidationSchema = z.object({
  date: reminderDateSchema,
});

/**
 * Paging, shared by the history and recipient lists.
 *
 * Query values arrive as strings, so they are coerced. The repository clamps
 * the result again — this rejects nonsense, that bounds the query.
 */
const pageQueryShape = {
  page: z.coerce
    .number({ error: 'page must be a number' })
    .int({ error: 'page must be a whole number' })
    .min(1, { error: 'page starts at 1' })
    .optional(),
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int({ error: 'limit must be a whole number' })
    .min(1, { error: 'limit must be at least 1' })
    .max(200, { error: 'limit may not exceed 200' })
    .optional(),
};

const listRemindersQueryValidationSchema = z.object(pageQueryShape);

const listRecipientsQueryValidationSchema = z.object({
  ...pageQueryShape,
  status: z.enum(ReminderDeliveryStatus).optional(),
});

export const reminderValidation = {
  sendReminderValidationSchema,
  targetsQueryValidationSchema,
  listRemindersQueryValidationSchema,
  listRecipientsQueryValidationSchema,
};
