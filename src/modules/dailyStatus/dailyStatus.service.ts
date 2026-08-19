import type { Response } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { getConfiguredGuilds } from '@/lib/discord/client';
import { guildLabel } from '@/lib/discord/fanout';
import {
  type DailyStatus,
  type DailyStatusRangeDay,
  type DailyStatusRangeRow,
  type DailyStatusRangeSortColumn,
  dailyStatusRepository,
  type DailyStatusRow,
  type RangeStatus,
} from '@/repositories/dailyStatus.repository';
import { dailyUpdateRepository } from '@/repositories/dailyUpdate.repository';
import { escapeCsvCell } from '@/utils/csv';
import { rangeDays, type TDateRange } from '@/utils/dhakaDate';

export type TDailyStatusFigures = {
  totalMembers: number;
  attendanceSubmitted: number;
  dailyUpdateSubmitted: number;
  bothComplete: number;
  missingUpdateOnly: number;
  missingAttendanceOnly: number;
  missingBoth: number;
};

export type TDailyStatusCountsResult = TDailyStatusFigures & {
  date: string;
  /**
   * The same seven figures per server, from the same source as the totals.
   *
   * These count MEMBERSHIPS while the combined figures count PEOPLE, so the
   * array does not sum to the totals when anyone is in two servers — the gap is
   * exactly the overlap. Both are wanted: the combined figures answer "how many
   * students are done today", the breakdown answers "how is each server doing".
   */
  byServer: (TDailyStatusFigures & { guildId: string; label: string })[];
};

/** A server an account belongs to, named for display. */
export type TServerRef = {
  guildId: string;
  label: string;
};

/**
 * One row of the dashboard: one PERSON, not one server membership.
 *
 * A student in two servers appears once, with both servers named in `servers`.
 * Their status credits work done in either — see the header of
 * `dailyStatus.repository.ts`.
 */
export type TDailyStatusRowResult = {
  discordUserId: string;
  /**
   * The account's member record in its lowest-numbered server — a stable key
   * for the detail route, which resolves the whole account from it.
   */
  memberId: string;
  /** Every member record behind this row, aligned with `servers`. */
  memberIds: string[];
  /** The servers this person is in, narrowed by any `guildId` filter. */
  servers: TServerRef[];
  /**
   * How many configured servers currently hold this account, ignoring the
   * filter — so a single-server view still shows that they are also elsewhere.
   */
  serverCount: number;
  discordUsername: string;
  displayName: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  hasAttendance: boolean;
  hasDailyUpdate: boolean;
  status: DailyStatus;
  attendanceSubmittedAt: string | null;
};

export type TMemberDailyStatusResult = TDailyStatusRowResult & {
  /**
   * Every message this person posted that day, across every server they are
   * in, as one timeline ordered by send time. Each names the server it came
   * from, so two servers read as one person's day rather than two lists.
   */
  messages: Array<{
    id: string;
    content: string;
    postedAt: string;
    guildId: string;
    serverLabel: string;
  }>;
};

export type TDailyStatusPageQuery = {
  date: string;
  guildId?: string;
  page?: number;
  limit?: number;
  status?: DailyStatus;
  search?: string;
};

export type TDailyStatusExportQuery = {
  date: string;
  guildId?: string;
  status?: DailyStatus;
  search?: string;
  format?: 'csv' | 'xlsx';
};

/** Every range response echoes the period it resolved, and its denominator. */
export type TRangeMeta = {
  mode: 'range';
  from: string;
  to: string;
  /** The weekday set applied, or null when every day in the span counted. */
  daysOfWeek: number[] | null;
  /** How many days actually counted — the denominator of every figure. */
  daysInRange: number;
};

/** The single-date counterpart, so a client never infers the mode. */
export type TDateMeta = {
  mode: 'date';
  date: string;
};

export type TDailyStatusRangeFigures = {
  totalMembers: number;
  allCompleteMembers: number;
  partialMembers: number;
  noneMembers: number;
  /** Person-day totals: summed across accounts, so they scale with the span. */
  attendanceDays: number;
  updateDays: number;
  completeDays: number;
  missedBothDays: number;
};

export type TDailyStatusRangeCountsResult = TRangeMeta &
  TDailyStatusRangeFigures & {
    /**
     * The same figures per server. These count MEMBERSHIPS while the combined
     * figures count PEOPLE, so the array does not sum to the totals when anyone
     * is in two servers — the gap is exactly the overlap, as in date mode.
     */
    byServer: (TDailyStatusRangeFigures & {
      guildId: string;
      label: string;
    })[];
  };

/**
 * One range row: one PERSON, with the single-day verdict replaced by per-day
 * counts.
 *
 * `incompleteDays` and `missedBothDays` are DIFFERENT figures and both are
 * reported. The reminder threshold acts on `missedBothDays`; an admin reading
 * only `incompleteDays` would set that threshold against a number the broadcast
 * does not use. There is deliberately no field called `missedDays`.
 */
export type TDailyStatusRangeRowResult = {
  discordUserId: string;
  memberId: string;
  memberIds: string[];
  servers: TServerRef[];
  serverCount: number;
  discordUsername: string;
  displayName: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  daysInRange: number;
  attendanceDays: number;
  updateDays: number;
  completeDays: number;
  incompleteDays: number;
  missedBothDays: number;
  missedUpdateDays: number;
  rangeStatus: RangeStatus;
  attendanceSubmittedAt: string | null;
};

export type TMemberDailyStatusRangeResult = TDailyStatusRangeRowResult & {
  /** One entry per counted day, reconciling with the counts above. */
  days: DailyStatusRangeDay[];
  /** Every message posted in the range, across every server, as one timeline. */
  messages: Array<{
    id: string;
    content: string;
    postedAt: string;
    guildId: string;
    serverLabel: string;
  }>;
};

export type TDailyStatusRangePageQuery = TDateRange & {
  guildId?: string;
  page?: number;
  limit?: number;
  rangeStatus?: RangeStatus;
  minMissedBothDays?: number;
  search?: string;
  sortBy?: DailyStatusRangeSortColumn;
  sortDir?: 'asc' | 'desc';
};

export type TDailyStatusRangeExportQuery = TDateRange & {
  guildId?: string;
  rangeStatus?: RangeStatus;
  minMissedBothDays?: number;
  search?: string;
  format?: 'csv' | 'xlsx';
};

/**
 * The counted days of a range, refusing a weekday set that leaves none.
 *
 * A denominator of zero would make every account fully complete by vacuous
 * truth — a dashboard reporting perfect compliance because the filter excluded
 * every day. That has to be an error the admin sees, not a result they trust.
 */
export const resolveRangeDays = (range: TDateRange): string[] => {
  const days = rangeDays(range);

  if (days.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `No days in ${range.from}..${range.to} match the selected days of week (${range.daysOfWeek?.join(', ')}). Widen the range or the weekday selection.`,
    );
  }

  return days;
};

/** The echoed period, built from the same values the query ran with. */
const rangeMetaOf = (range: TDateRange, daysInRange: number): TRangeMeta => ({
  mode: 'range',
  from: range.from,
  to: range.to,
  daysOfWeek: range.daysOfWeek?.length ? range.daysOfWeek : null,
  daysInRange,
});

/**
 * The display name for a server ID. Config, not storage — a stored label is a
 * second copy that goes stale the moment `.env` changes.
 */
const labelFor = (guildId: string): string => {
  const config = getConfiguredGuilds().find((g) => g.guildId === guildId);

  return config ? guildLabel(config) : guildId;
};

/**
 * Refuses a server that is not configured, rather than silently returning every
 * server. An admin who mistypes an ID must not be handed the whole directory
 * and told it is one server's.
 */
export const assertConfiguredGuild = (guildId?: string): void => {
  if (!guildId) return;

  if (!getConfiguredGuilds().some((g) => g.guildId === guildId)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Unknown server: ${guildId}. Configured servers are listed at GET /api/discord/servers.`,
    );
  }
};

/** The servers a row names, resolved to display labels. */
const serversOf = (guildIds: string[]): TServerRef[] =>
  guildIds.map((guildId) => ({ guildId, label: labelFor(guildId) }));

/**
 * Repository row to API row. Shared by the list and the per-person detail read
 * so the two cannot describe the same person differently.
 */
const toRowResult = (row: DailyStatusRow): TDailyStatusRowResult => ({
  discordUserId: row.discordUserId,
  memberId: row.memberId,
  memberIds: row.memberIds,
  servers: serversOf(row.guildIds),
  serverCount: row.serverCount,
  discordUsername: row.discordUsername,
  displayName: row.displayName,
  name: row.name,
  email: row.email,
  phone: row.phone,
  hasAttendance: row.hasAttendance,
  hasDailyUpdate: row.hasDailyUpdate,
  status: row.status,
  attendanceSubmittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
});

/** Repository range row to API range row, shared by the list and the detail. */
const toRangeRowResult = (
  row: DailyStatusRangeRow,
): TDailyStatusRangeRowResult => ({
  discordUserId: row.discordUserId,
  memberId: row.memberId,
  memberIds: row.memberIds,
  servers: serversOf(row.guildIds),
  serverCount: row.serverCount,
  discordUsername: row.discordUsername,
  displayName: row.displayName,
  name: row.name,
  email: row.email,
  phone: row.phone,
  daysInRange: Number(row.daysInRange),
  attendanceDays: Number(row.attendanceDays),
  updateDays: Number(row.updateDays),
  completeDays: Number(row.completeDays),
  incompleteDays: Number(row.incompleteDays),
  missedBothDays: Number(row.missedBothDays),
  missedUpdateDays: Number(row.missedUpdateDays),
  rangeStatus: row.rangeStatus,
  attendanceSubmittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
});

/**
 * Overview figures for a given date.
 */
const getCounts = async (
  date: string,
  guildId?: string,
): Promise<TDailyStatusCountsResult> => {
  assertConfiguredGuild(guildId);

  const counts = await dailyStatusRepository.getDailyStatusCounts(date, {
    guildId,
  });

  return {
    date,
    totalMembers: Number(counts.totalMembers),
    attendanceSubmitted: Number(counts.attendanceSubmitted),
    dailyUpdateSubmitted: Number(counts.dailyUpdateSubmitted),
    bothComplete: Number(counts.bothCompleted),
    missingUpdateOnly: Number(counts.missingUpdateOnly),
    missingAttendanceOnly: Number(counts.missingAttendanceOnly),
    missingBoth: Number(counts.missingBoth),
    byServer: counts.byServer.map((server) => ({
      guildId: server.guildId,
      label: labelFor(server.guildId),
      totalMembers: server.totalMembers,
      attendanceSubmitted: server.attendanceSubmitted,
      dailyUpdateSubmitted: server.dailyUpdateSubmitted,
      bothComplete: server.bothCompleted,
      missingUpdateOnly: server.missingUpdateOnly,
      missingAttendanceOnly: server.missingAttendanceOnly,
      missingBoth: server.missingBoth,
    })),
  };
};

/**
 * Paginated member status list for a given date.
 */
const getPage = async (
  query: TDailyStatusPageQuery,
): Promise<{ rows: TDailyStatusRowResult[]; total: number }> => {
  assertConfiguredGuild(query.guildId);

  const { rows, total } = await dailyStatusRepository.getDailyStatusPage(query);

  const mappedRows: TDailyStatusRowResult[] = rows.map(toRowResult);

  return { rows: mappedRows, total };
};

/**
 * Single member daily status and their messages on that date.
 */
const getMemberStatus = async (
  memberId: string,
  date: string,
): Promise<TMemberDailyStatusResult> => {
  const memberStatus = await dailyStatusRepository.getDailyStatusForMember(
    memberId,
    date,
  );

  if (!memberStatus) {
    throw new AppError(httpStatus.NOT_FOUND, 'Member not found');
  }

  // Sequential rather than parallel with the status read, because which member
  // records to read messages from is only known once the account is resolved.
  // Reading them from `memberId` alone would hide the messages this person
  // posted in their other server — the exact gap this whole change closes.
  const updates = await dailyUpdateRepository.listUpdatesByMemberIdsAndDate(
    memberStatus.memberIds,
    date,
  );

  const messages = updates.map((update) => ({
    id: update.id,
    content: update.message,
    postedAt: update.messageCreatedAt.toISOString(),
    guildId: update.member.guildId,
    serverLabel: labelFor(update.member.guildId),
  }));

  return { ...toRowResult(memberStatus), messages };
};

/**
 * Range overview figures.
 *
 * The three rollup buckets sum to `totalMembers`. The person-day totals do not
 * — they are a different unit and scale with the span.
 */
const getRangeCounts = async (
  range: TDateRange,
  guildId?: string,
): Promise<TDailyStatusRangeCountsResult> => {
  assertConfiguredGuild(guildId);

  const days = resolveRangeDays(range);
  const counts = await dailyStatusRepository.getDailyStatusRangeCounts(days, {
    guildId,
  });

  return {
    ...rangeMetaOf(range, counts.daysInRange),
    totalMembers: counts.totalMembers,
    allCompleteMembers: counts.allCompleteMembers,
    partialMembers: counts.partialMembers,
    noneMembers: counts.noneMembers,
    attendanceDays: counts.attendanceDays,
    updateDays: counts.updateDays,
    completeDays: counts.completeDays,
    missedBothDays: counts.missedBothDays,
    byServer: counts.byServer.map((server) => ({
      guildId: server.guildId,
      label: labelFor(server.guildId),
      totalMembers: server.totalMembers,
      allCompleteMembers: server.allCompleteMembers,
      partialMembers: server.partialMembers,
      noneMembers: server.noneMembers,
      attendanceDays: server.attendanceDays,
      updateDays: server.updateDays,
      completeDays: server.completeDays,
      missedBothDays: server.missedBothDays,
    })),
  };
};

/** Paginated per-person status over a range. */
const getRangePage = async (
  query: TDailyStatusRangePageQuery,
): Promise<{
  rows: TDailyStatusRangeRowResult[];
  total: number;
  meta: TRangeMeta;
}> => {
  assertConfiguredGuild(query.guildId);

  const days = resolveRangeDays(query);
  const { rows, total } = await dailyStatusRepository.getDailyStatusRangePage({
    days,
    guildId: query.guildId,
    rangeStatus: query.rangeStatus,
    minMissedBothDays: query.minMissedBothDays,
    search: query.search,
    page: query.page,
    limit: query.limit,
    sortBy: query.sortBy,
    sortDir: query.sortDir,
  });

  return {
    rows: rows.map(toRangeRowResult),
    total,
    meta: rangeMetaOf(query, days.length),
  };
};

/**
 * One account's range counts, its per-day breakdown, and its messages.
 *
 * The message read is sequential rather than parallel with the status read for
 * the same reason as in date mode: which member records to read from is only
 * known once the account is resolved, and reading from `memberId` alone would
 * hide what this person posted in their other server.
 */
const getMemberRangeStatus = async (
  memberId: string,
  range: TDateRange,
): Promise<TMemberDailyStatusRangeResult> => {
  const days = resolveRangeDays(range);
  const result = await dailyStatusRepository.getDailyStatusRangeForMember(
    memberId,
    days,
  );

  if (!result) {
    throw new AppError(httpStatus.NOT_FOUND, 'Member not found');
  }

  const updates = await dailyUpdateRepository.listUpdatesByMemberIdsAndDates(
    result.row.memberIds,
    days,
  );

  return {
    ...toRangeRowResult(result.row),
    days: result.days,
    messages: updates.map((update) => ({
      id: update.id,
      content: update.message,
      postedAt: update.messageCreatedAt.toISOString(),
      guildId: update.member.guildId,
      serverLabel: labelFor(update.member.guildId),
    })),
  };
};

/**
 * Stream filtered daily status rows as a CSV attachment.
 */
const exportCsv = async (
  query: TDailyStatusExportQuery,
  res: Response,
): Promise<void> => {
  if (query.format === 'xlsx') {
    throw new AppError(
      httpStatus.NOT_IMPLEMENTED,
      'XLSX export format is not supported yet. Please use format=csv.',
    );
  }

  assertConfiguredGuild(query.guildId);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // The server is named in the filename when the export is filtered, so two
  // downloads of the same date for different servers do not overwrite one
  // another in a downloads folder.
  const filenameSuffix = query.guildId
    ? `-${labelFor(query.guildId).replace(/[^a-zA-Z0-9_-]+/g, '-')}`
    : '';
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="daily-status-${query.date}${filenameSuffix}.csv"`,
  );

  const headers = [
    'servers',
    'discordUsername',
    'displayName',
    'name',
    'phone',
    'email',
    'status',
    'hasAttendance',
    'hasDailyUpdate',
    'attendanceSubmittedAt',
  ];

  res.write(headers.join(',') + '\n');

  const batchSize = 500;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { rows } = await dailyStatusRepository.getDailyStatusPage({
      date: query.date,
      status: query.status,
      search: query.search,
      guildId: query.guildId,
      page,
      limit: batchSize,
    });

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const line = [
        // Every server this person is in, in one cell — one row per person, so
        // there is no single server column to fill.
        escapeCsvCell(row.guildIds.map(labelFor).join(' | ')),
        escapeCsvCell(row.discordUsername),
        escapeCsvCell(row.displayName),
        escapeCsvCell(row.name),
        escapeCsvCell(row.phone),
        escapeCsvCell(row.email),
        escapeCsvCell(row.status),
        escapeCsvCell(row.hasAttendance),
        escapeCsvCell(row.hasDailyUpdate),
        escapeCsvCell(row.submittedAt ? row.submittedAt.toISOString() : ''),
      ].join(',');

      res.write(line + '\n');
    }

    if (rows.length < batchSize) {
      hasMore = false;
    } else {
      page += 1;
    }
  }

  res.end();
};

/**
 * Stream filtered range rows as a CSV attachment.
 *
 * A separate writer from `exportCsv` rather than a branch inside it: the two
 * write different columns under a different header, and the single-date header
 * has to stay byte-identical to what it has always been.
 */
const exportRangeCsv = async (
  query: TDailyStatusRangeExportQuery,
  res: Response,
): Promise<void> => {
  if (query.format === 'xlsx') {
    throw new AppError(
      httpStatus.NOT_IMPLEMENTED,
      'XLSX export format is not supported yet. Please use format=csv.',
    );
  }

  assertConfiguredGuild(query.guildId);

  const days = resolveRangeDays(query);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  const filenameSuffix = query.guildId
    ? `-${labelFor(query.guildId).replace(/[^a-zA-Z0-9_-]+/g, '-')}`
    : '';
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="daily-status-${query.from}_to_${query.to}${filenameSuffix}.csv"`,
  );

  const headers = [
    'servers',
    'discordUsername',
    'displayName',
    'name',
    'phone',
    'email',
    'rangeStatus',
    'daysInRange',
    'attendanceDays',
    'updateDays',
    'completeDays',
    'incompleteDays',
    'missedBothDays',
    'missedUpdateDays',
    'lastAttendanceSubmittedAt',
  ];

  res.write(headers.join(',') + '\n');

  const batchSize = 500;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { rows } = await dailyStatusRepository.getDailyStatusRangePage({
      days,
      guildId: query.guildId,
      rangeStatus: query.rangeStatus,
      minMissedBothDays: query.minMissedBothDays,
      search: query.search,
      page,
      limit: batchSize,
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      const line = [
        // Every server this person is in, in one cell — one row per person, so
        // there is no single server column to fill.
        escapeCsvCell(row.guildIds.map(labelFor).join(' | ')),
        escapeCsvCell(row.discordUsername),
        escapeCsvCell(row.displayName),
        escapeCsvCell(row.name),
        escapeCsvCell(row.phone),
        escapeCsvCell(row.email),
        escapeCsvCell(row.rangeStatus),
        escapeCsvCell(row.daysInRange),
        escapeCsvCell(row.attendanceDays),
        escapeCsvCell(row.updateDays),
        escapeCsvCell(row.completeDays),
        escapeCsvCell(row.incompleteDays),
        escapeCsvCell(row.missedBothDays),
        escapeCsvCell(row.missedUpdateDays),
        escapeCsvCell(row.submittedAt ? row.submittedAt.toISOString() : ''),
      ].join(',');

      res.write(line + '\n');
    }

    if (rows.length < batchSize) {
      hasMore = false;
    } else {
      page += 1;
    }
  }

  res.end();
};

export const dailyStatusService = {
  getCounts,
  getPage,
  getMemberStatus,
  exportCsv,
  getRangeCounts,
  getRangePage,
  getMemberRangeStatus,
  exportRangeCsv,
};
