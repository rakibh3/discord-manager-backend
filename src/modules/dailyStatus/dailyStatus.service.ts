import type { Response } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { getConfiguredGuilds } from '@/lib/discord/client';
import { guildLabel } from '@/lib/discord/fanout';
import {
  type DailyStatus,
  dailyStatusRepository,
} from '@/repositories/dailyStatus.repository';
import { dailyUpdateRepository } from '@/repositories/dailyUpdate.repository';

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
  /** The same seven figures per server, from the same query as the totals. */
  byServer: (TDailyStatusFigures & { guildId: string; label: string })[];
};

export type TDailyStatusRowResult = {
  memberId: string;
  guildId: string;
  serverLabel: string;
  /** How many configured servers currently hold this Discord account. */
  serverCount: number;
  discordUserId: string;
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
  messages: Array<{
    id: string;
    content: string;
    postedAt: string;
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

  const mappedRows: TDailyStatusRowResult[] = rows.map((row) => ({
    memberId: row.memberId,
    guildId: row.guildId,
    serverLabel: labelFor(row.guildId),
    serverCount: row.serverCount,
    discordUserId: row.discordUserId,
    discordUsername: row.discordUsername,
    displayName: row.displayName,
    name: row.name,
    email: row.email,
    phone: row.phone,
    hasAttendance: row.hasAttendance,
    hasDailyUpdate: row.hasDailyUpdate,
    status: row.status,
    attendanceSubmittedAt: row.submittedAt
      ? row.submittedAt.toISOString()
      : null,
  }));

  return { rows: mappedRows, total };
};

/**
 * Single member daily status and their messages on that date.
 */
const getMemberStatus = async (
  memberId: string,
  date: string,
): Promise<TMemberDailyStatusResult> => {
  const [memberStatus, updates] = await Promise.all([
    dailyStatusRepository.getDailyStatusForMember(memberId, date),
    dailyUpdateRepository.listUpdatesByMemberAndDate(memberId, date),
  ]);

  if (!memberStatus) {
    throw new AppError(httpStatus.NOT_FOUND, 'Member not found');
  }

  const messages = updates.map((update) => ({
    id: update.id,
    content: update.message,
    postedAt: update.messageCreatedAt.toISOString(),
  }));

  return {
    memberId: memberStatus.memberId,
    guildId: memberStatus.guildId,
    serverLabel: labelFor(memberStatus.guildId),
    serverCount: memberStatus.serverCount,
    discordUserId: memberStatus.discordUserId,
    discordUsername: memberStatus.discordUsername,
    displayName: memberStatus.displayName,
    name: memberStatus.name,
    email: memberStatus.email,
    phone: memberStatus.phone,
    hasAttendance: memberStatus.hasAttendance,
    hasDailyUpdate: memberStatus.hasDailyUpdate,
    status: memberStatus.status,
    attendanceSubmittedAt: memberStatus.submittedAt
      ? memberStatus.submittedAt.toISOString()
      : null,
    messages,
  };
};

/**
 * Escape a CSV cell value to prevent formula injection and handle delimiters.
 */
const escapeCsvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';

  let str = String(value);

  // Prevent spreadsheet formula injection when opened in Excel/Sheets
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }

  if (
    str.includes('"') ||
    str.includes(',') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
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
    'server',
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
        escapeCsvCell(labelFor(row.guildId)),
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

export const dailyStatusService = {
  getCounts,
  getPage,
  getMemberStatus,
  exportCsv,
};
