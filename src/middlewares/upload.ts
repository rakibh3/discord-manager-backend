import { Request } from 'express';
import httpStatus from 'http-status';
import multer, { MulterError } from 'multer';

import config from '@/config';
import AppError from '@/errors/AppError';

/**
 * The single-file upload used by the roster import.
 *
 * `memoryStorage`, deliberately: the buffer is parsed and discarded, so there is
 * no temp file on disk holding the names, email addresses, and phone numbers of
 * every enrolled student, and no cleanup path that can be got wrong. The size
 * bound is what makes that safe, and multer enforces it WHILE the upload is
 * still streaming — an oversized file is refused without ever being assembled
 * in memory or reaching the parser.
 */

/** The field name the client must use. */
export const ROSTER_FILE_FIELD = 'file';

const ACCEPTED_MIME_TYPES = new Set([
  // .xlsx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // .xls — accepted here so the service can answer with the specific
  // "re-save as .xlsx" instruction rather than a generic type refusal.
  'application/vnd.ms-excel',
  // .csv, in the several spellings browsers and clients actually send
  'text/csv',
  'application/csv',
  'text/plain',
  // Some clients send nothing useful at all.
  'application/octet-stream',
]);

/**
 * A first-pass filter only. The declared MIME type is supplied by the caller, so
 * it is never the thing that decides: `rosterWorkbook.ts` sniffs the actual
 * bytes and the service rejects anything that does not parse. This exists to
 * turn away the obviously-wrong upload (a PDF, an image) before it is buffered.
 */
const fileFilter: multer.Options['fileFilter'] = (_req, file, callback) => {
  if (ACCEPTED_MIME_TYPES.has(file.mimetype)) {
    callback(null, true);
    return;
  }

  callback(
    new AppError(
      httpStatus.BAD_REQUEST,
      'Upload an .xlsx workbook or a .csv file',
    ),
  );
};

export const rosterUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.roster.maxFileBytes,
    // One file, and no other multipart fields to buffer.
    files: 1,
  },
  fileFilter,
}).single(ROSTER_FILE_FIELD);

/**
 * Turns a multer failure into the 400 it actually is.
 *
 * Without this a `LIMIT_FILE_SIZE` reaches `globalErrorHandler` unrecognized and
 * surfaces as a generic 500 — an internal-error page for a condition that is
 * plainly the caller's, and one the administrator can fix if they are told what
 * the limit is.
 */
export const toUploadError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;

  if (error instanceof MulterError) {
    const megabytes = (config.roster.maxFileBytes / (1024 * 1024)).toFixed(1);

    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return new AppError(
          httpStatus.BAD_REQUEST,
          `The file is larger than the ${megabytes} MB limit`,
        );
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
        return new AppError(
          httpStatus.BAD_REQUEST,
          `Upload exactly one file, in the "${ROSTER_FILE_FIELD}" field`,
        );
      default:
        return new AppError(
          httpStatus.BAD_REQUEST,
          `Upload failed: ${error.message}`,
        );
    }
  }

  return new AppError(httpStatus.BAD_REQUEST, 'Upload failed');
};

/**
 * Runs the upload middleware and normalizes its failures.
 *
 * Called from the controller rather than mounted on the route so the rejection
 * travels through `catchAsync` as an `AppError`, the way every other failure in
 * this application does.
 */
export const runRosterUpload = (
  req: Request,
  res: Parameters<typeof rosterUpload>[1],
) =>
  new Promise<void>((resolve, reject) => {
    rosterUpload(req, res, (error: unknown) => {
      if (error) reject(toUploadError(error));
      else resolve();
    });
  });
