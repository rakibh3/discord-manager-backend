import { Buffer } from 'node:buffer';

import { Prisma } from '@generated/prisma/client';
import type { Response } from 'express';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import { getConfiguredGuilds } from '@/lib/discord/client';
import { guildLabel } from '@/lib/discord/fanout';
import {
  rosterRepository,
  type TListEntriesQuery,
} from '@/repositories/roster.repository';
import {
  PAIRING_STATE,
  type PairingState,
  ROSTER_STATUS,
  type RosterStatus,
  type RosterStatusCounts,
  type RosterStatusQuery,
  type RosterStatusRangeCounts,
  type RosterStatusRangeQuery,
  type RosterStatusRangeRow,
  rosterStatusRepository,
  type RosterStatusRow,
  type RosterStatusSortColumn,
} from '@/repositories/rosterStatus.repository';
import { escapeCsvCell } from '@/utils/csv';
import {
  rangeDays,
  resolvePeriod,
  type TResolvedPeriod,
} from '@/utils/dhakaDate';
import { normalizeRosterEmail } from '@/utils/rosterEmail';
import {
  HEADER_ALIASES,
  parseRosterWorkbook,
  type TDuplicateReport,
  type TRowRejection,
  validateRosterRows,
} from '@/utils/rosterWorkbook';

/**
 * Business rules for the enrolment roster.
 *
 * `AppError` appears here and nowhere below it — the repository returns data and
 * the parser returns reasons; deciding that a parse failure is a 400 and an
 * empty roster is a refusal to arm the gate is this layer's job.
 */

/**
 * Imports a workbook.
 *
 * The order matters and is the whole design: parse → reject the FILE if it is
 * unusable → validate each ROW → write what passed → audit. A file-level
 * problem (unreadable, no email column, too many rows) refuses everything before
 * a single write, because every row would fail identically and a summary of
 * 5,000 identical failures is a worse report than one message naming the
 * problem. A row-level problem skips that row and is reported by its number.
 */
/**
 * Just the two fields the import needs from an uploaded file.
 *
 * Structural rather than `Express.Multer.File`, so this service depends on the
 * shape of an upload and not on multer's global namespace augmentation — which
 * also keeps the module testable with a plain object.
 */
export type TUploadedFile = {
  buffer: Buffer;
  originalname: string;
};

const importRoster = async (
  file: TUploadedFile | undefined,
  adminId: string,
) => {
  if (!file) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Attach the spreadsheet in the "file" field',
    );
  }

  const parsed = await parseRosterWorkbook(file.buffer, file.originalname);

  if (parsed.kind === 'legacy-xls') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'This is a legacy .xls file, which cannot be read. Open it in Excel or Google Sheets and save it as .xlsx, then upload again.',
    );
  }

  if (parsed.kind === 'unreadable') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `The file could not be read as a spreadsheet (${parsed.reason}). Upload an .xlsx workbook or a .csv file.`,
    );
  }

  if (parsed.kind === 'bad-header') {
    // Raised here rather than from a Zod schema on purpose: this message names
    // literal column headings the administrator must type, and
    // `handleZodValidationError` title-cases every word — turning `email
    // address` into `Email Address` and defeating the point of listing them.
    const missing = parsed.missing.join(' and ');
    const accepted = parsed.missing
      .map((field) => `${field}: ${HEADER_ALIASES[field].join(', ')}`)
      .join(' | ');
    const found = parsed.headersFound.length
      ? parsed.headersFound.join(', ')
      : 'none';

    throw new AppError(
      httpStatus.BAD_REQUEST,
      `The sheet has no ${missing} column. Headers found: ${found}. Accepted headings — ${accepted}. Nothing was imported.`,
    );
  }

  if (parsed.kind === 'too-many-rows') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `The sheet has ${parsed.totalRows} rows, above the ${parsed.limit} row limit. Nothing was imported.`,
    );
  }

  const { rows, rejected, duplicates } = validateRosterRows(parsed.rows);

  const outcome = await rosterRepository.upsertEntriesInChunks(rows);

  // Rows in a chunk that failed to commit were neither created nor updated, so
  // they are skipped for reporting purposes — the counts must account for every
  // row read or the summary is not reconcilable.
  const skippedCount = rejected.length + outcome.failed;

  // Rows that were collapsed into an earlier one because they repeated an
  // address already seen. Reported as its own figure rather than folded into
  // `skipped`, because nothing about them was rejected: the address IS on the
  // roster, carrying the last row's values. Without this the summary does not
  // add up — a sheet listing one person twice reads as one row unaccounted for.
  const collapsedRows = duplicates.reduce(
    (total, entry) => total + entry.rowNumbers.length - 1,
    0,
  );

  const record = await rosterRepository.createImportRecord({
    fileName: file.originalname,
    importedById: adminId,
    totalRows: parsed.totalRows,
    createdCount: outcome.created,
    updatedCount: outcome.updated,
    skippedCount,
    duplicateCount: duplicates.length,
  });

  return {
    importId: record.id,
    fileName: record.fileName,
    totalRows: parsed.totalRows,
    created: outcome.created,
    updated: outcome.updated,
    skipped: skippedCount,
    /** Distinct addresses that appeared more than once in the sheet. */
    duplicates: duplicates.length,
    /**
     * Rows absorbed by an earlier row carrying the same address.
     *
     * `created + updated + skipped + duplicateRowsCollapsed === totalRows`.
     */
    duplicateRowsCollapsed: collapsedRows,
    /** Every row that was not loaded, with the line number in the sheet. */
    rejectedRows: rejected satisfies TRowRejection[],
    /** Addresses that appeared more than once. The last occurrence won. */
    duplicateAddresses: duplicates satisfies TDuplicateReport[],
    /** Present only when a whole batch failed to commit. */
    batchFailures: outcome.failures,
  };
};

const listRoster = async (query: TListEntriesQuery) =>
  rosterRepository.listEntries(query);

const listImports = async (paging: { page: number; limit: number }) =>
  rosterRepository.listImports(paging);

/**
 * Whether a P2002 is the roster's unique email constraint firing.
 *
 * Matches on the serialized `meta` rather than `meta.target`, which is
 * `undefined` under the `@prisma/adapter-pg` driver adapter this project uses —
 * the constraint arrives nested at
 * `meta.driverAdapterError.cause.constraint.fields` instead, a driver-specific
 * path that is not part of Prisma's documented contract. Reading it
 * field-by-field fails SILENTLY on an adapter change: the conflict would slip
 * through to the generic "Duplicate Error" instead of the message naming the
 * address. Same technique as `attendance.service.ts`.
 */
const isDuplicateEmailError = (
  error: Prisma.PrismaClientKnownRequestError,
): boolean =>
  error.code === 'P2002' && JSON.stringify(error.meta ?? {}).includes('email');

const updateEntry = async (
  id: string,
  input: { name?: string; email?: string; phone?: string | null },
) => {
  // Not-found comes back as P2025 from the update and is shaped centrally, but
  // the read makes the 404 unambiguous before a conflicting email is compared.
  const existing = await rosterRepository.findEntryById(id);

  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Roster entry not found');
  }

  try {
    return await rosterRepository.updateEntry(id, {
      ...input,
      // Belt and braces: the schema already normalizes, and normalizing twice
      // is idempotent. What must never happen is an un-normalized value
      // reaching the column the lookup matches exactly.
      ...(input.email ? { email: normalizeRosterEmail(input.email) } : {}),
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      isDuplicateEmailError(error)
    ) {
      throw new AppError(
        httpStatus.CONFLICT,
        'Another roster entry already holds that email address',
      );
    }

    throw error;
  }
};

/** Removal is a flag. The row stays, so the change is reversible. */
const deactivateEntry = async (id: string) => {
  const existing = await rosterRepository.findEntryById(id);

  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Roster entry not found');
  }

  return rosterRepository.setEntryActive(id, false);
};

const restoreEntry = async (id: string) => {
  const existing = await rosterRepository.findEntryById(id);

  if (!existing) {
    throw new AppError(httpStatus.NOT_FOUND, 'Roster entry not found');
  }

  return rosterRepository.setEntryActive(id, true);
};

/**
 * The enforcement flag, reported alongside the active count.
 *
 * The count is part of the read rather than a separate endpoint because it is
 * what makes the effect of arming visible BEFORE it is armed. An administrator
 * about to enable a gate needs to see how many people it will admit.
 */
const getSettings = async () => {
  const [settings, activeEntries] = await Promise.all([
    rosterRepository.getOrCreateSettings(),
    rosterRepository.countActiveEntries(),
  ]);

  return {
    enforceEmail: settings.enforceEmail,
    activeEntries,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
  };
};

/**
 * Arms or disarms the roster gate.
 *
 * Enabling against an empty roster is refused, and that refusal is the whole
 * safety story of this feature. With the gate on and nothing to match against,
 * every student in every server is refused with a correct-looking 403 — an
 * outage whose only symptom is a collapse in submission volume, discovered
 * hours later by someone noticing the dashboard is empty.
 *
 * The guard lives HERE, on the arming step where a human reads the message, and
 * deliberately NOT on the submission path. An "if the roster is empty, skip the
 * check" rule there would be a gate that disarms itself under a condition
 * nobody is watching.
 *
 * Disabling is always allowed, whatever the roster holds: the rollback for this
 * feature must never itself be refusable.
 */
const updateSettings = async (
  { enforceEmail }: { enforceEmail: boolean },
  adminId: string,
) => {
  if (enforceEmail) {
    const activeEntries = await rosterRepository.countActiveEntries();

    if (activeEntries === 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'The roster has no active entries. Enabling the email check now would refuse every submission. Import the roster first.',
      );
    }
  }

  const settings = await rosterRepository.updateSettings({
    enforceEmail,
    updatedById: adminId,
  });

  return {
    enforceEmail: settings.enforceEmail,
    activeEntries: await rosterRepository.countActiveEntries(),
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
  };
};

/* ────────────────────────────────────────────────────────────────────────────
 * Roster engagement status
 *
 * The roster report's denominator is ENROLMENT, not Discord membership. It
 * counts "who that we enrolled is doing the work", which is a different
 * question from the daily-status dashboard's "who in our servers is behind".
 *
 * Roster totals will NOT equal dashboard totals, and that is the same class of
 * apparent bug as "combined totals do not equal the sum of `byServer`" — see
 * the file header of `rosterStatus.repository.ts` and CLAUDE.md. The service
 * surfaces both views; reconciling them would be a mistake.
 *
 * Period handling is shared with the daily-status service: a date XOR a
 * from/to pair, an optional weekday set, the same 92-day cap. A weekday set
 * that leaves zero counted days is a 400, with the same message the dashboard
 * uses — a denominator of zero would make every paired entry fully complete
 * by vacuous truth.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A server the paired account belongs to, resolved to a display label. */
type TRosterStatusServer = {
  guildId: string;
  label: string;
};

/** Display name for a server, from configuration — never persisted. */
const labelForGuildId = (guildId: string): string => {
  const config = getConfiguredGuilds().find((g) => g.guildId === guildId);

  return config ? guildLabel(config) : guildId;
};

/** Resolve raw server IDs to display labels at serialization time. */
const serversOf = (guildIds: string[]): TRosterStatusServer[] =>
  guildIds.map((guildId) => ({
    guildId,
    label: labelForGuildId(guildId),
  }));

/** Repository row → API row, shared by the listing and the export. */
const toRosterStatusResult = (row: RosterStatusRow) => ({
  entryId: row.entryId,
  name: row.name,
  email: row.email,
  phone: row.phone,
  isActive: row.isActive,
  discordUserId: row.discordUserId,
  linkedAt: row.linkedAt ? row.linkedAt.toISOString() : null,
  servers: serversOf(row.guildIds),
  serverCount: Number(row.serverCount),
  discordUsername: row.discordUsername,
  displayName: row.displayName,
  isInGuild: row.isInGuild,
  hasAttendance: row.hasAttendance,
  hasDailyUpdate: row.hasDailyUpdate,
  status: row.status,
  /**
   * The count of open discord-pairing-mismatch reports filed against this
   * entry. Zero for unpaired entries without an additional read; positive
   * values surface as a "needs attention" cue on the dashboard.
   */
  openDiscordPairingMismatchReports: row.openDiscordPairingMismatchReports,
});

/** Repository range row → API row. */
const toRosterStatusRangeResult = (row: RosterStatusRangeRow) => ({
  entryId: row.entryId,
  name: row.name,
  email: row.email,
  phone: row.phone,
  isActive: row.isActive,
  discordUserId: row.discordUserId,
  linkedAt: row.linkedAt ? row.linkedAt.toISOString() : null,
  servers: serversOf(row.guildIds),
  serverCount: Number(row.serverCount),
  discordUsername: row.discordUsername,
  displayName: row.displayName,
  isInGuild: row.isInGuild,
  daysInRange: Number(row.daysInRange),
  attendanceDays: Number(row.attendanceDays),
  updateDays: Number(row.updateDays),
  completeDays: Number(row.completeDays),
  incompleteDays: Number(row.incompleteDays),
  missedBothDays: Number(row.missedBothDays),
  missedUpdateDays: Number(row.missedUpdateDays),
  rangeStatus: row.rangeStatus,
  status: row.status,
  /**
   * The count of open discord-pairing-mismatch reports filed against this
   * entry. Zero for unpaired entries without an additional read; positive
   * values surface as a "needs attention" cue on the dashboard.
   */
  openDiscordPairingMismatchReports: row.openDiscordPairingMismatchReports,
});

/** Echoed meta for the range mode. Mirrors the dashboard's `rangeMetaOf`. */
type TRosterStatusRangeMeta = {
  mode: 'range';
  from: string;
  to: string;
  daysOfWeek: number[] | null;
  daysInRange: number;
};

type TRosterStatusDateMeta = {
  mode: 'date';
  date: string;
};

type TRosterStatusMeta = TRosterStatusDateMeta | TRosterStatusRangeMeta;

/**
 * Resolve the period to one of the two tagged forms the repository branches
 * on, and enumerate the counted days for range mode.
 *
 * The schema has already refused every malformed combination, so this only has
 * to read which of the two valid forms arrived and translate it.
 *
 * A weekday set that matches no day in the range would make every paired
 * entry `ALL_COMPLETE` by vacuous truth — refused here as a 400.
 */
const resolveRosterStatusPeriod = (
  period: TResolvedPeriod,
): {
  mode: 'date' | 'range';
  days: string[];
  meta: TRosterStatusMeta;
} => {
  if (period.mode === 'date') {
    return {
      mode: 'date',
      days: [period.date],
      meta: { mode: 'date', date: period.date },
    };
  }

  const days = rangeDays(period);

  if (days.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `No days in ${period.from}..${period.to} match the selected days of week (${period.daysOfWeek?.join(', ')}). Widen the range or the weekday selection.`,
    );
  }

  return {
    mode: 'range',
    days,
    meta: {
      mode: 'range',
      from: period.from,
      to: period.to,
      daysOfWeek: period.daysOfWeek?.length ? period.daysOfWeek : null,
      daysInRange: days.length,
    },
  };
};

/** A request resolved by the validation layer — see `roster.validation.ts`. */
export type TRosterStatusPeriodInput = {
  date?: string;
  from?: string;
  to?: string;
  daysOfWeek?: number[];
};

/**
 * Translate a validated query into the resolved period the service consumes.
 *
 * Pulled out so the listing, counts, and export endpoints all branch on the
 * same tagged form — a single source of truth for "is this a date or a range".
 */
export const resolveRosterStatusPeriodInput = (
  input: TRosterStatusPeriodInput,
) => resolveRosterStatusPeriod(resolvePeriod(input));

/** Counts for a date or a range. */
const getStatusCounts = async (
  input: TRosterStatusPeriodInput,
): Promise<{ meta: TRosterStatusMeta; counts: RosterStatusCounts | RosterStatusRangeCounts }> => {
  const resolved = resolveRosterStatusPeriodInput(input);

  if (resolved.mode === 'date' && resolved.meta.mode === 'date') {
    const counts = await rosterStatusRepository.getRosterStatusCounts(
      resolved.meta.date,
    );

    return { meta: resolved.meta, counts };
  }

  if (resolved.mode === 'range' && resolved.meta.mode === 'range') {
    const counts = await rosterStatusRepository.getRosterStatusRangeCounts(
      resolved.days,
    );

    return { meta: resolved.meta, counts };
  }

  throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Period resolution mismatch');
};

/** Listing for a date or a range. */
const getStatusPage = async (
  input: RosterStatusQuery | RosterStatusRangeQuery,
): Promise<{
  meta: TRosterStatusMeta;
  rows: ReturnType<typeof toRosterStatusResult>[] | ReturnType<typeof toRosterStatusRangeResult>[];
  total: number;
}> => {
  if ('date' in input) {
    const { rows, total } = await rosterStatusRepository.getRosterStatusPage(input);

    return {
      meta: { mode: 'date', date: input.date },
      rows: rows.map(toRosterStatusResult),
      total,
    };
  }

  const { rows, total } = await rosterStatusRepository.getRosterStatusRangePage(input);

  return {
    meta: {
      mode: 'range',
      from: input.days[0] as string,
      to: input.days[input.days.length - 1] as string,
      daysOfWeek: null,
      daysInRange: input.days.length,
    },
    rows: rows.map(toRosterStatusRangeResult),
    total,
  };
};

/** Same query surface as the listing — used by the export. */
export type TRosterStatusExportQuery =
  | (Omit<RosterStatusQuery, 'page' | 'limit'> & { format?: 'csv' | 'xlsx' })
  | (Omit<RosterStatusRangeQuery, 'page' | 'limit'> & {
      format?: 'csv' | 'xlsx';
    });

/**
 * Stream filtered roster status rows as a CSV attachment.
 *
 * Honours the same period and filters as the listing. The deliverable for
 * enrolled people with no Discord account on file: name, email, phone number,
 * and the fact that nothing has been recorded for them — they cannot be DM'd
 * because no account is known, so outreach happens by email outside this
 * system.
 *
 * Format the system does not produce (`xlsx`) is refused with the same 400
 * the daily-status export uses, naming the supported format. CSV escaping
 * uses the shared `escapeCsvCell` from `src/utils/csv.ts` so exactly one
 * escaper exists.
 */
const exportStatusCsv = async (
  input: TRosterStatusExportQuery,
  res: Response,
): Promise<void> => {
  // xlsx is the one format we explicitly do not produce yet — same message
  // the daily-status export uses, so an admin sees one refusal rather than
  // two. `NOT_IMPLEMENTED` is the status the daily-status export uses for
  // the same reason.
  if ('format' in input && input.format === 'xlsx') {
    throw new AppError(
      httpStatus.NOT_IMPLEMENTED,
      'XLSX export format is not supported yet. Please use format=csv.',
    );
  }

  if ('date' in input) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="roster-status-${input.date}.csv"`,
    );

    res.write(
      [
        'name',
        'email',
        'phone',
        'discordUserId',
        'linkedAt',
        'discordUsername',
        'displayName',
        'servers',
        'hasAttendance',
        'hasDailyUpdate',
        'status',
      ].join(',') + '\n',
    );

    const batchSize = 500;
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const { rows } = await rosterStatusRepository.getRosterStatusPage({
        date: input.date,
        pairingState: input.pairingState,
        status: input.status,
        search: input.search,
        sortBy: input.sortBy,
        sortDir: input.sortDir,
        page,
        limit: batchSize,
      });

      if (rows.length === 0) break;

      for (const row of rows) {
        const line = [
          escapeCsvCell(row.name),
          escapeCsvCell(row.email),
          escapeCsvCell(row.phone),
          escapeCsvCell(row.discordUserId),
          escapeCsvCell(row.linkedAt ? row.linkedAt.toISOString() : ''),
          escapeCsvCell(row.discordUsername),
          escapeCsvCell(row.displayName),
          // Every server the paired account is in, in one cell — one row per
          // enrolled person, so there is no single server column to fill.
          escapeCsvCell(
            row.guildIds.map((g) => labelForGuildId(g)).join(' | '),
          ),
          escapeCsvCell(row.hasAttendance),
          escapeCsvCell(row.hasDailyUpdate),
          escapeCsvCell(row.status),
        ].join(',');

        res.write(line + '\n');
      }

      if (rows.length < batchSize) hasMore = false;
      else page += 1;
    }

    res.end();

    return;
  }

  // Range mode.
  const days = input.days;
  const from = days[0] as string;
  const to = days[days.length - 1] as string;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="roster-status-${from}_to_${to}.csv"`,
  );

  res.write(
    [
      'name',
      'email',
      'phone',
      'discordUserId',
      'linkedAt',
      'discordUsername',
      'displayName',
      'servers',
      'daysInRange',
      'attendanceDays',
      'updateDays',
      'completeDays',
      'incompleteDays',
      'missedBothDays',
      'missedUpdateDays',
      'rangeStatus',
    ].join(',') + '\n',
  );

  const batchSize = 500;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { rows } = await rosterStatusRepository.getRosterStatusRangePage({
      days,
      pairingState: input.pairingState,
      status: input.status,
      search: input.search,
      sortBy: input.sortBy,
      sortDir: input.sortDir,
      page,
      limit: batchSize,
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      const line = [
        escapeCsvCell(row.name),
        escapeCsvCell(row.email),
        escapeCsvCell(row.phone),
        escapeCsvCell(row.discordUserId),
        escapeCsvCell(row.linkedAt ? row.linkedAt.toISOString() : ''),
        escapeCsvCell(row.discordUsername),
        escapeCsvCell(row.displayName),
        escapeCsvCell(
          row.guildIds.map((g) => labelForGuildId(g)).join(' | '),
        ),
        escapeCsvCell(row.daysInRange),
        escapeCsvCell(row.attendanceDays),
        escapeCsvCell(row.updateDays),
        escapeCsvCell(row.completeDays),
        escapeCsvCell(row.incompleteDays),
        escapeCsvCell(row.missedBothDays),
        escapeCsvCell(row.missedUpdateDays),
        escapeCsvCell(row.rangeStatus),
      ].join(',');

      res.write(line + '\n');
    }

    if (rows.length < batchSize) hasMore = false;
    else page += 1;
  }

  res.end();
};

export const rosterService = {
  importRoster,
  listRoster,
  listImports,
  updateEntry,
  deactivateEntry,
  restoreEntry,
  getSettings,
  updateSettings,
  getStatusCounts,
  getStatusPage,
  exportStatusCsv,
  resolveRosterStatusPeriodInput,
};

// Re-export so the controller does not need a direct repository import.
export {
  PAIRING_STATE,
  type PairingState,
  ROSTER_STATUS,
  type RosterStatus,
  type RosterStatusSortColumn,
};
