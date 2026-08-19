import { Buffer } from 'node:buffer';

import { Prisma } from '@generated/prisma/client';
import httpStatus from 'http-status';

import AppError from '@/errors/AppError';
import {
  rosterRepository,
  type TListEntriesQuery,
} from '@/repositories/roster.repository';
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

export const rosterService = {
  importRoster,
  listRoster,
  listImports,
  updateEntry,
  deactivateEntry,
  restoreEntry,
  getSettings,
  updateSettings,
};
