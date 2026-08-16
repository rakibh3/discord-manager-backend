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

/**
 * Wall-clock formatters for the scheduler.
 *
 * Where `getDhakaDate` answers "which day is this instant on", these answer
 * "what does a clock on a wall in Dhaka read right now" — the question the
 * channel scheduler has to settle at boot to decide whether the current moment
 * falls inside the configured open/lock window, and the one a stored `18:00`
 * has to be compared against.
 *
 * `hour12: false` alone yields `24:05` at five past midnight in some ICU
 * versions, which sorts and compares wrongly against a stored `00:05`.
 * `hourCycle: 'h23'` pins it to `00`–`23`.
 *
 * Both are `TZ`-independent for exactly the reason `getDhakaDate` is: the zone
 * is supplied explicitly, so a server running under `TZ=UTC` fires its jobs at
 * the same Dhaka moment as one running under `TZ=Asia/Dhaka`.
 */
const dhakaTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DHAKA_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  hourCycle: 'h23',
});

/**
 * The `HH:mm` a wall clock in Dhaka reads at an instant, zero-padded.
 *
 * Sorts and compares lexicographically, which is what makes
 * `open <= now && now <= close` a plain string comparison in the scheduler.
 */
export const getDhakaTimeOfDay = (instant: Date = new Date()): string =>
  dhakaTimeFormatter.format(instant);

/**
 * The day of the week in Dhaka as `0` (Sunday) through `6` (Saturday) — the
 * same numbering cron uses, so a stored `daysOfWeek` array feeds both the cron
 * expression and the boot reconcile without a second convention.
 *
 * Never `Date.getDay()`, which reads the day in the *server's* timezone: at
 * 01:00 Tuesday in Dhaka a UTC server still says Monday, and the reconcile
 * would check the wrong day's schedule.
 *
 * Computed from the Dhaka civil date rather than from a localized weekday name,
 * so it depends on nothing but `getDhakaDate` — the one producer of days in
 * this system — and cannot be shifted by the runtime's locale data.
 */
export const getDhakaWeekday = (instant: Date = new Date()): number => {
  const date = getDhakaDate(instant);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));

  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

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

/**
 * A 24-hour `HH:mm` wall-clock time: `00:00` through `23:59`.
 *
 * The regex is the whole check — unlike a calendar date there is no rollover
 * to catch, because the hour and minute ranges are expressed in the pattern.
 */
const TIME_OF_DAY_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isValidTimeOfDay = (value: string): boolean =>
  TIME_OF_DAY_SHAPE.test(value);

/**
 * Shared Zod schema for a stored schedule time, the sibling of
 * `dhakaDateSchema`. One definition so the request validation, the repository
 * input, and the scheduler's own parsing cannot drift — a `6:00 PM` that slips
 * past validation becomes a cron expression that never fires.
 */
export const timeOfDaySchema = z.string().refine(isValidTimeOfDay, {
  error: 'Time must be a 24-hour HH:mm value between 00:00 and 23:59',
});
