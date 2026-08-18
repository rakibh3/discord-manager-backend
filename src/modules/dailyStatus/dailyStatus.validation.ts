import { z } from 'zod';

import {
  DAILY_STATUS,
  type DailyStatus,
  RANGE_STATUS,
  type RangeStatus,
} from '@/repositories/dailyStatus.repository';
import { dateOrRangeQueryShape, refineDateOrRange } from '@/utils/dhakaDate';

const statusValues = Object.values(DAILY_STATUS) as [
  DailyStatus,
  ...DailyStatus[],
];
const statusSchema = z.enum(statusValues);

const rangeStatusValues = Object.values(RANGE_STATUS) as [
  RangeStatus,
  ...RangeStatus[],
];
const rangeStatusSchema = z.enum(rangeStatusValues);

/**
 * Optional server filter, shared by every endpoint here.
 *
 * Whether the ID is actually configured is checked in the service, so the error
 * can name the unknown server rather than reading as a format problem.
 */
const guildIdSchema = z
  .string()
  .trim()
  .regex(/^\d{17,20}$/, {
    error: 'guildId must be a Discord snowflake (17-20 digits)',
  })
  .optional();

const pageShape = {
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

/**
 * The two status filters, and why they are mutually exclusive with each other's
 * mode.
 *
 * `status` is the four-bucket verdict for ONE day; `rangeStatus` is the rollup
 * over a span. Neither can describe the other's period, so each is rejected in
 * the wrong mode by `refineStatusFilters` rather than silently ignored — a
 * filter that is accepted and does nothing is how an admin comes to trust a
 * list that is not filtered the way they think it is.
 */
const statusFilterShape = {
  status: statusSchema.optional(),
  rangeStatus: rangeStatusSchema.optional(),
  /**
   * Keep only accounts that did NEITHER thing on at least this many counted
   * days. The same computed column the reminder thresholds on, so the dashboard
   * can preview a broadcast's exact target set.
   */
  minMissedBothDays: z.coerce
    .number({ error: 'minMissedBothDays must be a number' })
    .int({ error: 'minMissedBothDays must be a whole number' })
    .min(1, { error: 'minMissedBothDays starts at 1' })
    .optional(),
};

type TStatusFilterInput = {
  date?: string;
  from?: string;
  status?: DailyStatus;
  rangeStatus?: RangeStatus;
  minMissedBothDays?: number;
};

const refineStatusFilters = (
  value: TStatusFilterInput,
  ctx: z.RefinementCtx,
): void => {
  const isRange = value.from !== undefined && value.date === undefined;

  if (isRange && value.status !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message:
        'status describes a single day — filter a range with rangeStatus instead',
    });
  }

  if (!isRange && value.rangeStatus !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['rangeStatus'],
      message:
        'rangeStatus describes a span of days — filter a single date with status instead',
    });
  }

  if (!isRange && value.minMissedBothDays !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['minMissedBothDays'],
      message:
        'minMissedBothDays counts days across a range — it does not apply to a single date',
    });
  }
};

/**
 * `GET /api/daily-status/counts?date=…` or `?from=…&to=…[&daysOfWeek=…]`
 */
const countsQuerySchema = z
  .object({ ...dateOrRangeQueryShape, guildId: guildIdSchema })
  .superRefine(refineDateOrRange);

/**
 * `GET /api/daily-status?date=…|from=…&to=…&page=&limit=&status=&search=`
 */
const pageQuerySchema = z
  .object({
    ...dateOrRangeQueryShape,
    ...pageShape,
    ...statusFilterShape,
    guildId: guildIdSchema,
    search: z.string().trim().optional(),
  })
  .superRefine((value, ctx) => {
    refineDateOrRange(value, ctx);
    refineStatusFilters(value, ctx);
  });

/**
 * `GET /api/daily-status/members/:memberId?date=…|from=…&to=…`
 */
const memberQuerySchema = z
  .object(dateOrRangeQueryShape)
  .superRefine(refineDateOrRange);

/**
 * `GET /api/daily-status/export?date=…|from=…&to=…&status=&search=&format=csv`
 */
const exportQuerySchema = z
  .object({
    ...dateOrRangeQueryShape,
    ...statusFilterShape,
    guildId: guildIdSchema,
    search: z.string().trim().optional(),
    format: z.enum(['csv', 'xlsx']).default('csv'),
  })
  .superRefine((value, ctx) => {
    refineDateOrRange(value, ctx);
    refineStatusFilters(value, ctx);
  });

export const dailyStatusValidation = {
  countsQuerySchema,
  pageQuerySchema,
  memberQuerySchema,
  exportQuerySchema,
};
