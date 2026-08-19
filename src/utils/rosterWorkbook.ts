import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

import ExcelJS from 'exceljs';

import config from '@/config';
import { isValidRosterEmail, normalizeRosterEmail } from '@/utils/rosterEmail';

/**
 * Parsing of the roster spreadsheet an administrator uploads.
 *
 * Pure with respect to the database: it turns a buffer into rows and reasons,
 * and decides nothing about what to store. The service owns the writes and the
 * HTTP outcomes; nothing in here throws an `AppError` or names a status code.
 *
 * Every result the caller must react to is returned as a discriminated `kind`
 * rather than raised, because the difference between "this file is unusable"
 * and "these twelve rows are unusable" is the difference between a 400 and a
 * 200 with a summary, and that decision belongs to the service.
 */

/**
 * Header aliases, matched case-insensitively after trimming.
 *
 * Columns are located BY NAME, never by position. An administrator who inserts
 * a column ahead of the others would otherwise load phone numbers into the
 * email column, and — with enforcement on — every affected student would be
 * refused. A lockout produced by a spreadsheet edit, with nothing in the system
 * looking wrong.
 *
 * Unrecognized columns (batch, roll number, section, …) are ignored rather than
 * treated as an error: real rosters carry them, and refusing the file over a
 * column nobody reads would be useless strictness.
 */
export const HEADER_ALIASES = {
  email: ['email', 'email address', 'e-mail', 'e mail', 'mail'],
  name: ['name', 'full name', 'student name', 'fullname'],
  phone: [
    'phone',
    'phone number',
    'mobile',
    'mobile number',
    'contact',
    'contact number',
  ],
} as const;

type TField = keyof typeof HEADER_ALIASES;

/** One data row as read from the sheet, before validation. */
export type TParsedRow = {
  /** The workbook's own row number, so a report names the line the admin sees. */
  rowNumber: number;
  name: string;
  email: string;
  phone: string | null;
};

export type TParseResult =
  | { kind: 'ok'; rows: TParsedRow[]; totalRows: number }
  /** The file cannot be parsed at all. */
  | { kind: 'unreadable'; reason: string }
  /** Legacy binary `.xls`, which the parser genuinely cannot read. */
  | { kind: 'legacy-xls' }
  /** No usable header row, or a required column missing from it. */
  | { kind: 'bad-header'; missing: TField[]; headersFound: string[] }
  | { kind: 'too-many-rows'; totalRows: number; limit: number };

/** The ZIP local-file-header magic every `.xlsx` (an OOXML zip) starts with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** The OLE2 compound-document magic the legacy binary `.xls` starts with. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const startsWithBytes = (buffer: Buffer, magic: number[]): boolean =>
  buffer.length >= magic.length &&
  magic.every((byte, index) => buffer[index] === byte);

/**
 * A legacy binary `.xls`, identified by its OLE2 signature.
 *
 * Detected explicitly because ExcelJS reads `.xlsx` and `.csv` only. Left to
 * fall through, such a file produces an opaque parse error, and an
 * administrator whose spreadsheet "just doesn't work" has no way to learn that
 * the format is the reason. Sniffed from the bytes rather than the filename,
 * since the extension is caller-supplied.
 */
export const isLegacyXls = (buffer: Buffer): boolean =>
  startsWithBytes(buffer, OLE2_MAGIC);

const isXlsx = (buffer: Buffer): boolean => startsWithBytes(buffer, ZIP_MAGIC);

const normalizeHeader = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

/** The display text of a cell, as a trimmed string. Empty when the cell is blank. */
const cellText = (cell: ExcelJS.Cell | undefined): string => {
  if (!cell) return '';

  const { value } = cell;
  if (value === null || value === undefined) return '';

  // `cell.text` renders formulas, dates, and rich text the way the sheet shows
  // them, which is what an administrator means by "what is in that cell".
  // Hyperlinked email cells arrive as an object carrying the display text.
  if (typeof value === 'object' && 'text' in value) {
    return String((value as { text: unknown }).text ?? '').trim();
  }

  return String(cell.text ?? '').trim();
};

const cellTextsOf = (row: ExcelJS.Row): string[] => {
  const texts: string[] = [];
  row.eachCell({ includeEmpty: false }, (cell) => texts.push(cellText(cell)));
  return texts;
};

/** Maps header cells onto field names. Returns which fields were located where. */
const mapHeaderRow = (row: ExcelJS.Row) => {
  const columns: Partial<Record<TField, number>> = {};
  const headersFound: string[] = [];

  row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const text = cellText(cell);
    if (!text) return;

    headersFound.push(text);
    const normalized = normalizeHeader(text);

    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [
      TField,
      readonly string[],
    ][]) {
      // First match wins, so a sheet with two email-ish columns uses the
      // leftmost rather than silently preferring the last.
      if (columns[field] === undefined && aliases.includes(normalized)) {
        columns[field] = columnNumber;
      }
    }
  });

  return { columns, headersFound };
};

/**
 * Reads a workbook buffer into rows.
 *
 * `.csv` is accepted alongside `.xlsx` because it is what an administrator gets
 * from exporting almost anything, and the parser reads it through the same code
 * path once loaded.
 */
export const parseRosterWorkbook = async (
  buffer: Buffer,
  originalName: string,
): Promise<TParseResult> => {
  if (isLegacyXls(buffer)) return { kind: 'legacy-xls' };

  const workbook = new ExcelJS.Workbook();

  try {
    if (isXlsx(buffer)) {
      // ExcelJS declares its own global `Buffer extends ArrayBuffer`, which a
      // Node `Buffer` (a `Uint8Array`) does not structurally satisfy. It reads
      // a Node buffer perfectly well at runtime; the cast is purely to bridge
      // the two declarations.
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } else if (originalName.toLowerCase().endsWith('.csv')) {
      await workbook.csv.read(Readable.from(buffer));
    } else {
      return {
        kind: 'unreadable',
        reason: 'The file is not an .xlsx workbook or a .csv file',
      };
    }
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: error instanceof Error ? error.message : 'Unknown parse error',
    };
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { kind: 'unreadable', reason: 'The file contains no worksheet' };
  }

  // The header is the first row carrying any text, not necessarily row 1 —
  // exported sheets often open with a blank spacer row or two.
  let headerRow: ExcelJS.Row | undefined;
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    if (headerRow) return;
    const hasText = row.values && cellTextsOf(row).some(Boolean);
    if (hasText) headerRow = row;
  });

  if (!headerRow) {
    return { kind: 'bad-header', missing: ['email', 'name'], headersFound: [] };
  }

  const { columns, headersFound } = mapHeaderRow(headerRow);

  // Email and name are both required, and their absence rejects the WHOLE file
  // before any write. This is the one class of error where partial success
  // misleads rather than helps: every row would fail identically, so a 200
  // reporting 5,000 skipped rows is a worse report than one 400 naming the
  // headers found and the aliases accepted.
  const missing: TField[] = [];
  if (columns.email === undefined) missing.push('email');
  if (columns.name === undefined) missing.push('name');
  if (missing.length > 0) return { kind: 'bad-header', missing, headersFound };

  const rows: TParsedRow[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow!.number) return;

    const name = cellText(row.getCell(columns.name!));
    const email = cellText(row.getCell(columns.email!));
    const phone =
      columns.phone === undefined ? '' : cellText(row.getCell(columns.phone));

    // Blank in every recognized column: a trailing or spacer row. Ignored
    // silently rather than reported, because reporting it is noise an
    // administrator cannot act on.
    if (!name && !email && !phone) return;

    rows.push({ rowNumber, name, email, phone: phone || null });
  });

  // Checked after parsing and before any write — a blast-radius control, so it
  // must refuse the file rather than truncate it.
  if (rows.length > config.roster.maxRows) {
    return {
      kind: 'too-many-rows',
      totalRows: rows.length,
      limit: config.roster.maxRows,
    };
  }

  return { kind: 'ok', rows, totalRows: rows.length };
};

export type TRowRejection = {
  rowNumber: number;
  reason: string;
};

export type TDuplicateReport = {
  email: string;
  /** Every row that carried this address, in sheet order. The last one won. */
  rowNumbers: number[];
};

export type TValidationResult = {
  /** One row per distinct address, ready to write. */
  rows: { email: string; name: string; phone: string | null }[];
  rejected: TRowRejection[];
  duplicates: TDuplicateReport[];
};

/**
 * Validates parsed rows and collapses repeats of the same address.
 *
 * A failing row is skipped and reported by ITS OWN row number; it never stops
 * the rest of the workbook from loading. A repeated address resolves to the
 * LAST row that carried it and is reported with every row number involved —
 * silently absorbing a repeat would hide a real mistake in the source
 * spreadsheet, while rejecting the whole file over one would be
 * disproportionate.
 */
export const validateRosterRows = (rows: TParsedRow[]): TValidationResult => {
  const rejected: TRowRejection[] = [];
  const seen = new Map<
    string,
    { name: string; phone: string | null; rowNumbers: number[] }
  >();

  for (const row of rows) {
    if (!row.email) {
      rejected.push({
        rowNumber: row.rowNumber,
        reason: 'Missing email address',
      });
      continue;
    }

    if (!isValidRosterEmail(row.email)) {
      rejected.push({
        rowNumber: row.rowNumber,
        reason: `Invalid email address: ${row.email}`,
      });
      continue;
    }

    if (!row.name) {
      rejected.push({ rowNumber: row.rowNumber, reason: 'Missing name' });
      continue;
    }

    const email = normalizeRosterEmail(row.email);
    const existing = seen.get(email);

    if (existing) {
      // Last row wins; the earlier values are replaced.
      existing.name = row.name;
      existing.phone = row.phone;
      existing.rowNumbers.push(row.rowNumber);
      continue;
    }

    seen.set(email, {
      name: row.name,
      phone: row.phone,
      rowNumbers: [row.rowNumber],
    });
  }

  const result: TValidationResult = { rows: [], rejected, duplicates: [] };

  for (const [email, entry] of seen) {
    result.rows.push({ email, name: entry.name, phone: entry.phone });
    if (entry.rowNumbers.length > 1) {
      result.duplicates.push({ email, rowNumbers: entry.rowNumbers });
    }
  }

  return result;
};
