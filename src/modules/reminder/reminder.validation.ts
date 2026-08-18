import { ReminderDeliveryStatus } from '@generated/prisma/enums';
import { z } from 'zod';

import { MAX_REMINDER_MESSAGE_LENGTH } from '@/lib/discord/dm';
import { REMINDER_CRITERION } from '@/repositories/dailyStatus.repository';
import {
  countDhakaDaysInclusive,
  dateOrRangeBodyShape,
  dateOrRangeQueryShape,
  getDhakaDate,
  isValidDhakaDate,
  refineDateOrRange,
} from '@/utils/dhakaDate';

/**
 * Field rules for reminder broadcasts.
 *
 * The stakes here are not the usual validation stakes: a request that passes
 * this schema sends a private message to thousands of people and cannot be
 * undone. Everything that can be caught before that happens is caught here.
 */

/**
 * The criteria that decide who is behind, shared by the preview and the send so
 * a preview can never be computed from criteria the send would reject.
 *
 * `criterion` defaults to `MISSING_UPDATE`, which is exactly what a broadcast
 * meant before ranges existed. That default is deliberate rather than
 * convenient: making `MISSING_BOTH` universal would silently stop reminding a
 * student who fills the attendance form and never posts an update, and the
 * daily-update channel is what this feature exists to drive.
 */
const criteriaShape = {
  criterion: z
    .enum(REMINDER_CRITERION)
    .default(REMINDER_CRITERION.MISSING_UPDATE),
  minMissedDays: z.coerce
    .number({ error: 'minMissedDays must be a number' })
    .int({ error: 'minMissedDays must be a whole number' })
    .min(1, { error: 'minMissedDays starts at 1' })
    .default(1),
};

type TPeriodInput = {
  date?: string;
  from?: string;
  to?: string;
  daysOfWeek?: number[];
  minMissedDays?: number;
};

/**
 * The shared period rules PLUS the two this path alone imposes.
 *
 * The future rule lives here rather than in `refineDateOrRange` because the
 * dashboard reads history and has no reason to refuse a future date, while a
 * broadcast must: there is nothing to be missing yet, so every member would be
 * a target.
 *
 * The threshold rule is here for a related reason — a minimum higher than the
 * number of days in the period can never be met, so it is a request that would
 * always find nobody. Better a validation error than a silent empty run.
 */
const refineReminderPeriod = (
  value: TPeriodInput,
  ctx: z.RefinementCtx,
): void => {
  refineDateOrRange(value, ctx);

  const today = getDhakaDate();
  const end = value.date ?? value.to;

  // Only meaningful once the value is a real date. Chained on a malformed one,
  // the lexicographic comparison would add a second, nonsensical message
  // alongside the format error — two complaints for one mistake.
  if (end !== undefined && isValidDhakaDate(end) && end > today) {
    ctx.addIssue({
      code: 'custom',
      path: [value.date !== undefined ? 'date' : 'to'],
      message:
        'The period cannot end in the future — there is nothing to remind about yet',
    });
  }

  if (value.from !== undefined && value.to !== undefined) {
    const span = countDhakaDaysInclusive(value.from, value.to);
    const min = value.minMissedDays ?? 1;

    if (
      isValidDhakaDate(value.from) &&
      isValidDhakaDate(value.to) &&
      min > span
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minMissedDays'],
        message: `minMissedDays of ${min} cannot be met in a ${span}-day period — nobody could ever be targeted`,
      });
    }
  }
};

/**
 * `POST /api/reminders/send`
 *
 * The message cap leaves room for the fixed heading the DM is wrapped in, so a
 * message that validates here always fits in one Discord message. Discovering
 * the overflow at send time would mean a broadcast that fails for every single
 * recipient, one rate-limited job at a time.
 */
const sendReminderValidationSchema = z
  .object({
    ...dateOrRangeBodyShape,
    ...criteriaShape,
    message: z
      .string({ error: 'A reminder message is required' })
      .trim()
      .min(1, { error: 'The reminder message cannot be empty' })
      .max(MAX_REMINDER_MESSAGE_LENGTH, {
        error: `The reminder message must be ${MAX_REMINDER_MESSAGE_LENGTH} characters or fewer, so it fits in one Discord message alongside the reminder heading`,
      }),
    /**
     * Restrict the broadcast to named servers. Omitted means every configured
     * server, which is the ordinary case.
     *
     * Whether an ID is configured is checked in the service, so the error names
     * the unknown server rather than reading as a format complaint.
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
          'Provide at least one server ID, or omit guildIds entirely to remind every configured server',
      })
      .optional(),
  })
  .superRefine(refineReminderPeriod);

/**
 * `GET /api/reminders/targets` — the preview, before anything is sent.
 *
 * Takes the identical period and criteria fields as the send, and refuses
 * exactly what the send refuses. A preview computed under rules the send would
 * reject is worse than no preview: it is a number an admin acts on.
 */
const targetsQueryValidationSchema = z
  .object({
    ...dateOrRangeQueryShape,
    ...criteriaShape,
    /** Comma-separated server IDs; omitted means every configured server. */
    guildIds: z
      .string()
      .trim()
      .optional()
      .transform((value) =>
        value
          ? value
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
          : undefined,
      ),
  })
  .superRefine(refineReminderPeriod);

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
