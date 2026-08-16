import type { ChannelSchedule } from '@generated/prisma/client';

import { prisma } from '@/lib/prisma';

/**
 * Data access for `channel_schedules`.
 *
 * Repositories own Prisma and nothing else: no `AppError`, no HTTP status
 * codes, no `req`. The schedule lives here rather than inside the schedule
 * module because its readers are not all HTTP-scoped — the scheduler loads it
 * from a `node-cron` callback and from process startup, with no request in
 * sight, and must run the same query the admin endpoints do.
 */

/** The only key in use today. See the model comment on `key`. */
export const DAILY_UPDATE_SCHEDULE_KEY = 'DAILY_UPDATE';

/**
 * PID §7 / §14: the channel opens at 6:00 PM and locks at 11:59 PM, every day.
 * These are the values the row is born with; from then on the dashboard owns
 * them.
 */
export const DEFAULT_SCHEDULE = {
  openTime: '18:00',
  closeTime: '23:59',
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
};

/** The stored row plus the admin who last touched it, for the read payload. */
export type TChannelScheduleWithEditor = ChannelSchedule & {
  updatedBy: { id: string; name: string; email: string } | null;
};

const editorSelect = {
  updatedBy: { select: { id: true, name: true, email: true } },
};

/**
 * The daily-update schedule, created with the defaults on first access.
 *
 * An upsert rather than a find-then-create: the row is created lazily on first
 * read, and startup reconcile plus a dashboard request can easily arrive
 * together on a cold deployment. Two concurrent find-then-creates would both
 * see no row and both insert; the unique index on `key` makes the upsert the
 * only version that cannot produce a duplicate.
 *
 * `update: {}` is deliberate — an existing row is returned untouched, so this
 * can be called on every scheduler tick without rewriting `updatedAt` and
 * making the audit field lie about when an admin last changed something.
 */
const getOrCreateSchedule = async (): Promise<TChannelScheduleWithEditor> =>
  prisma.channelSchedule.upsert({
    where: { key: DAILY_UPDATE_SCHEDULE_KEY },
    update: {},
    create: { key: DAILY_UPDATE_SCHEDULE_KEY, ...DEFAULT_SCHEDULE },
    include: editorSelect,
  });

export type TUpdateScheduleInput = {
  /** `HH:mm`, Asia/Dhaka. Validate with `timeOfDaySchema`. */
  openTime?: string;
  closeTime?: string;
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek?: number[];
  enabled?: boolean;
  /** The admin making the change; recorded for the audit. */
  updatedById: string;
};

/**
 * Applies a partial change to the schedule.
 *
 * Whether the resulting window is coherent — close after open, at least one
 * weekday — is settled by the service before this is called. This layer stores
 * what it is given.
 */
const updateSchedule = async ({
  updatedById,
  ...fields
}: TUpdateScheduleInput): Promise<TChannelScheduleWithEditor> =>
  prisma.channelSchedule.update({
    where: { key: DAILY_UPDATE_SCHEDULE_KEY },
    data: { ...fields, updatedById },
    include: editorSelect,
  });

export const channelScheduleRepository = {
  getOrCreateSchedule,
  updateSchedule,
};
