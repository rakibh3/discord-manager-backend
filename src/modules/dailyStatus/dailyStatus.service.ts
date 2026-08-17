import type { Response } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import {
  type DailyStatus,
  dailyStatusRepository,
} from '@/repositories/dailyStatus.repository';
import { dailyUpdateRepository } from '@/repositories/dailyUpdate.repository';

export type TDailyStatusCountsResult = {
  date: string;
  totalMembers: number;
  attendanceSubmitted: number;
  dailyUpdateSubmitted: number;
  bothComplete: number;
  missingUpdateOnly: number;
  missingAttendanceOnly: number;
  missingBoth: number;
};

export type TDailyStatusRowResult = {
  memberId: string;
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
  page?: number;
  limit?: number;
  status?: DailyStatus;
  search?: string;
};

export type TDailyStatusExportQuery = {
  date: string;
  status?: DailyStatus;
  search?: string;
  format?: 'csv' | 'xlsx';
};

/**
 * Overview figures for a given date.
 */
const getCounts = async (date: string): Promise<TDailyStatusCountsResult> => {
  const counts = await dailyStatusRepository.getDailyStatusCounts(date);

  return {
    date,
    totalMembers: Number(counts.totalMembers),
    attendanceSubmitted: Number(counts.attendanceSubmitted),
    dailyUpdateSubmitted: Number(counts.dailyUpdateSubmitted),
    bothComplete: Number(counts.bothCompleted),
    missingUpdateOnly: Number(counts.missingUpdateOnly),
    missingAttendanceOnly: Number(counts.missingAttendanceOnly),
    missingBoth: Number(counts.missingBoth),
  };
};

/**
 * Paginated member status list for a given date.
 */
const getPage = async (
  query: TDailyStatusPageQuery,
): Promise<{ rows: TDailyStatusRowResult[]; total: number }> => {
  const { rows, total } = await dailyStatusRepository.getDailyStatusPage(query);

  const mappedRows: TDailyStatusRowResult[] = rows.map((row) => ({
    memberId: row.memberId,
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

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="daily-status-${query.date}.csv"`,
  );

  const headers = [
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
      page,
      limit: batchSize,
    });

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const line = [
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
