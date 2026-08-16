import { z } from 'zod';

/**
 * The single timezone the whole system reasons about days in.
 *
 * Named as an IANA zone rather than a fixed `UTC+6` offset on purpose:
 * Bangladesh observes no DST today, but hard-coding the offset means a future
 * DST decision would silently corrupt every day boundary.
 */
export const DHAKA_TIMEZONE = 'Asia/Dhaka';

/**
 * `en-CA` formats dates as `YYYY-MM-DD` by locale definition, which is exactly
 * the civil-date form stored in `attendance_date`, `message_date`, and
 * `reminder_date`. Constructed once — `Intl.DateTimeFormat` is expensive enough
 * that rebuilding it per call shows up when formatting thousands of rows.
 */
const dhakaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DHAKA_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The `YYYY-MM-DD` civil date an instant falls on in Dhaka.
 *
 * This is the ONLY place a civil date is derived. Every consumer — the
 * attendance form, daily-update ingestion, the scheduler, the reminder queue —
 * calls this rather than slicing an ISO string, which would yield the UTC day
 * and put a 23:58 Dhaka submission on the wrong date.
 *
 * The result is independent of the server's own `TZ`, because the timezone is
 * supplied explicitly.
 *
 * `instant` defaults to now, but is deliberately a parameter: a daily update
 * belongs to the day its message was *sent*, and a reminder run just after
 * midnight operates on the day that has already closed.
 */
export const getDhakaDate = (instant: Date = new Date()): string =>
  dhakaDateFormatter.format(instant);

/** Shape check only. A well-formed-looking `2026-02-30` still passes this. */
const DHAKA_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a value is a well-formed `YYYY-MM-DD` string AND a real calendar date.
 *
 * The round-trip through `Date.UTC` is what rejects `2026-02-30` and
 * `2026-13-01`: JS silently rolls those over to March 2nd and January 2027, so
 * the reconstructed parts no longer match the input.
 *
 * Guards the database, where the column is a plain `String` and Postgres would
 * happily store anything at all.
 */
export const isValidDhakaDate = (value: string): boolean => {
  if (!DHAKA_DATE_SHAPE.test(value)) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

/**
 * Shared Zod schema for any Dhaka civil date crossing a boundary — a request
 * body, a query parameter, or a repository argument. One definition so the
 * format can never drift between the validation layer and the data layer.
 */
export const dhakaDateSchema = z.string().refine(isValidDhakaDate, {
  error: 'Date must be a valid calendar date in YYYY-MM-DD format',
});
