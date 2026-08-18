import { z } from 'zod';

import {
  DAILY_STATUS,
  type DailyStatus,
} from '@/repositories/dailyStatus.repository';
import { dhakaDateSchema } from '@/utils/dhakaDate';

const statusValues = Object.values(DAILY_STATUS) as [
  DailyStatus,
  ...DailyStatus[],
];
const statusSchema = z.enum(statusValues);

/**
 * `GET /api/daily-status/counts?date=YYYY-MM-DD`
 */
const countsQuerySchema = z.object({
  date: dhakaDateSchema,
  /**
   * Optional server filter. Omitted means every configured server.
   *
   * Whether the ID is actually configured is checked in the service, so the
   * error can name the unknown server rather than reading as a format problem.
   */
  guildId: z
    .string()
    .trim()
    .regex(/^\d{17,20}$/, {
      error: 'guildId must be a Discord snowflake (17-20 digits)',
    })
    .optional(),
});

/**
 * `GET /api/daily-status?date=YYYY-MM-DD&page=1&limit=50&status=&search=`
 */
const pageQuerySchema = z.object({
  date: dhakaDateSchema,
  /**
   * Optional server filter. Omitted means every configured server.
   *
   * Whether the ID is actually configured is checked in the service, so the
   * error can name the unknown server rather than reading as a format problem.
   */
  guildId: z
    .string()
    .trim()
    .regex(/^\d{17,20}$/, {
      error: 'guildId must be a Discord snowflake (17-20 digits)',
    })
    .optional(),
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
  status: statusSchema.optional(),
  search: z.string().trim().optional(),
});

/**
 * `GET /api/daily-status/members/:memberId?date=YYYY-MM-DD`
 */
const memberQuerySchema = z.object({
  date: dhakaDateSchema,
});

/**
 * `GET /api/daily-status/export?date=YYYY-MM-DD&status=&search=&format=csv|xlsx`
 */
const exportQuerySchema = z.object({
  date: dhakaDateSchema,
  /**
   * Optional server filter. Omitted means every configured server.
   *
   * Whether the ID is actually configured is checked in the service, so the
   * error can name the unknown server rather than reading as a format problem.
   */
  guildId: z
    .string()
    .trim()
    .regex(/^\d{17,20}$/, {
      error: 'guildId must be a Discord snowflake (17-20 digits)',
    })
    .optional(),
  status: statusSchema.optional(),
  search: z.string().trim().optional(),
  format: z.enum(['csv', 'xlsx']).default('csv'),
});

export const dailyStatusValidation = {
  countsQuerySchema,
  pageQuerySchema,
  memberQuerySchema,
  exportQuerySchema,
};
