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

/**
 * Formatter used to derive Dhaka's GMT offset at a given instant.
 *
 * Bangladesh observes no DST today (+06:00), but has observed DST as recently
 * as 2009. Deriving the offset from `Intl` via `DHAKA_TIMEZONE` keeps
 * `DHAKA_TIMEZONE` the single definition of the zone in the entire system,
 * so any future DST rule changes follow the runtime's tz database rather than
 * drifting from hardcoded offsets.
 */
const dhakaOffsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DHAKA_TIMEZONE,
  timeZoneName: 'longOffset',
});

/**
 * Extracts Dhaka's timezone offset in minutes from an approximate instant.
 *
 * Defensively falls back to +360 minutes (+06:00) if the runtime returns an
 * unexpected format, ensuring that calling routes never throw a 500 error.
 */
const getDhakaOffsetMinutes = (instant: Date): number => {
  try {
    const parts = dhakaOffsetFormatter.formatToParts(instant);
    const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (tzPart) {
      const match = tzPart.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
      if (match) {
        const sign = match[1] === '-' ? -1 : 1;
        const hours = Number(match[2]);
        const mins = Number(match[3] ?? '0');
        return sign * (hours * 60 + mins);
      }
    }
  } catch {
    // Fall back to standard Dhaka offset (+06:00)
  }
  return 6 * 60;
};

/**
 * Converts a Dhaka wall-clock date (`YYYY-MM-DD`) and time (`HH:mm`) into an
 * absolute `Date` instant.
 *
 * Interprets the wall clock as a UTC timestamp initially, derives Dhaka's
 * GMT offset at that approximate instant via `Intl`, and subtracts it to produce
 * the exact UTC instant.
 *
 * Independent of the server's own `TZ`.
 */
export const dhakaWallClockToInstant = (date: string, time: string): Date => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));

  const utcMs = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMinutes = getDhakaOffsetMinutes(new Date(utcMs));

  return new Date(utcMs - offsetMinutes * 60 * 1000);
};

/**
 * Adds (or subtracts) a given number of days to/from a `YYYY-MM-DD` Dhaka civil date,
 * returning the resulting `YYYY-MM-DD` string.
 *
 * Uses `Date.UTC(year, month - 1, day + days)` reformatted through `getDhakaDate`,
 * matching the technique `getDhakaWeekday` uses so month and year rollovers
 * come reliably from the platform.
 */
export const addDhakaDays = (date: string, days: number): string => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));

  return getDhakaDate(new Date(Date.UTC(year, month - 1, day + days)));
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

/**
 * The longest span any endpoint will aggregate or broadcast over, in days,
 * counting both ends.
 *
 * This is NOT a query-cost limit — a ninety-day aggregation is bounded and
 * cheap. It is a blast-radius control: `from`/`to` reach an irreversible mass
 * DM, and a mistyped year has to come back as a validation error rather than
 * as five thousand people being messaged. The dashboard shares the cap so that
 * every range an admin can preview is a range they can actually act on.
 */
export const MAX_RANGE_DAYS = 92;

/** An inclusive span of Dhaka civil dates, optionally narrowed to weekdays. */
export type TDateRange = {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
  /**
   * Which weekdays inside the span count, in cron's 0-is-Sunday numbering —
   * the same numbering `ChannelSchedule.daysOfWeek` and `getDhakaWeekday` use,
   * so one array feeds every consumer with no translation layer to get
   * backwards. Omitted or empty means every day in the span counts.
   */
  daysOfWeek?: number[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The UTC midnight of a `YYYY-MM-DD` civil date, for arithmetic only. */
const civilDateToUtcMs = (date: string): number =>
  Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );

/**
 * How many calendar days an inclusive `from`..`to` span covers.
 *
 * Both ends are civil dates, so this is deliberately arithmetic on UTC
 * midnights rather than on instants: no timezone is involved and none can
 * shift the answer. `from === to` is 1, not 0.
 *
 * Expects two already-validated dates; a caller passing garbage gets NaN
 * rather than a thrown error, which is why every caller runs it behind
 * `isValidDhakaDate`.
 */
export const countDhakaDaysInclusive = (from: string, to: string): number =>
  Math.round((civilDateToUtcMs(to) - civilDateToUtcMs(from)) / MS_PER_DAY) + 1;

/**
 * A single weekday number. `z.coerce` because a query string delivers `"0"`
 * while a JSON body delivers `0`, and both are the same value.
 */
const weekdaySchema = z.coerce
  .number({ error: 'Each day of week must be a number' })
  .int({ error: 'Each day of week must be a whole number' })
  .min(0, { error: 'Days of week run from 0 (Sunday) to 6 (Saturday)' })
  .max(6, { error: 'Days of week run from 0 (Sunday) to 6 (Saturday)' });

/**
 * The weekday set as it arrives in a JSON body. Rejects duplicates, because a
 * repeated day would read as if it counted twice and it does not.
 */
export const daysOfWeekArraySchema = z
  .array(weekdaySchema)
  .min(1, {
    error:
      'Provide at least one day of week, or omit daysOfWeek entirely to count every day in the range',
  })
  .refine((days) => new Set(days).size === days.length, {
    error: 'Days of week must not repeat',
  });

/**
 * The same set as it arrives in a query string: `daysOfWeek=0,1,2,3,4`.
 *
 * Split before validation so `daysOfWeek=7` reports the range rule rather than
 * a type error about a string.
 */
export const daysOfWeekQuerySchema = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : value,
  daysOfWeekArraySchema,
);

/**
 * The `date` XOR `from`+`to` field set, for a query string.
 *
 * Every field is optional here and the choice between them is enforced by
 * `refineDateOrRange` below, because "exactly one of these two forms" is a
 * relationship between fields and cannot be expressed on any one of them.
 */
export const dateOrRangeQueryShape = {
  date: dhakaDateSchema.optional(),
  from: dhakaDateSchema.optional(),
  to: dhakaDateSchema.optional(),
  daysOfWeek: daysOfWeekQuerySchema.optional(),
};

/** The same field set for a JSON body, where `daysOfWeek` is already an array. */
export const dateOrRangeBodyShape = {
  date: dhakaDateSchema.optional(),
  from: dhakaDateSchema.optional(),
  to: dhakaDateSchema.optional(),
  daysOfWeek: daysOfWeekArraySchema.optional(),
};

type TDateOrRangeInput = {
  date?: string;
  from?: string;
  to?: string;
  daysOfWeek?: number[];
};

/**
 * Enforces that a request states exactly one period, and that a range is a
 * usable one.
 *
 * Each failure gets its own message naming the specific conflict rather than a
 * shared "invalid period". `handleZodValidationError` title-cases every word of
 * whatever comes out of here, so a generic message survives the journey to the
 * client as an equally generic one — the specific text is the only part that
 * still helps.
 *
 * The future-end rule is deliberately NOT here: the dashboard reads history and
 * has no reason to refuse a future date, while a broadcast must. That check
 * belongs to the reminder schema alone.
 */
export const refineDateOrRange = (
  value: TDateOrRangeInput,
  ctx: z.RefinementCtx,
): void => {
  const hasDate = value.date !== undefined;
  const hasFrom = value.from !== undefined;
  const hasTo = value.to !== undefined;

  if (hasDate && (hasFrom || hasTo)) {
    ctx.addIssue({
      code: 'custom',
      path: ['date'],
      message:
        'Supply either a single date or a from/to range, not both — they describe different periods',
    });

    return;
  }

  if (!hasDate && !hasFrom && !hasTo) {
    ctx.addIssue({
      code: 'custom',
      path: ['date'],
      message: 'Supply either a single date or a from/to range',
    });

    return;
  }

  if (hasFrom !== hasTo) {
    ctx.addIssue({
      code: 'custom',
      path: [hasFrom ? 'to' : 'from'],
      message: 'A range needs both from and to',
    });

    return;
  }

  if (hasDate) {
    if (value.daysOfWeek !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['daysOfWeek'],
        message:
          'daysOfWeek applies to a from/to range only — a single date is one day',
      });
    }

    return;
  }

  const from = value.from as string;
  const to = value.to as string;

  // Both bounds already failed their own format check if they are not real
  // dates, and the comparisons below are lexicographic — `'2026-08-18' <
  // 'not-a-date'` is true, so carrying on would report "the end cannot be
  // earlier than its start" about a value that is not a date at all. Two
  // messages for one mistake, one of them nonsense; the same trap
  // `reminderDateSchema` avoids with `.pipe`.
  if (!isValidDhakaDate(from) || !isValidDhakaDate(to)) return;

  if (to < from) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'The end of the range cannot be earlier than its start',
    });

    return;
  }

  const span = countDhakaDaysInclusive(from, to);

  if (span > MAX_RANGE_DAYS) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: `A range may span at most ${MAX_RANGE_DAYS} days, but this one spans ${span}`,
    });
  }
};

/**
 * The explicit list of `YYYY-MM-DD` days a range covers, after `daysOfWeek`.
 *
 * This is the SINGLE definition of "which days count", and it lives here
 * because this module is already the single producer of Dhaka civil dates.
 * The aggregation binds the resulting array straight into SQL rather than
 * rebuilding the set there with `generate_series` + `EXTRACT(DOW …)`, which
 * would be a second convention to keep in step with this one.
 *
 * The weekday is computed the same way `getDhakaWeekday` computes it — from
 * the civil date through `Date.UTC`, so it is 0-is-Sunday and independent of
 * the server's `TZ`. That is the same numbering Postgres's `EXTRACT(DOW …)`
 * and cron use, so the array needs no translation anywhere it travels.
 *
 * Returns an empty array when `daysOfWeek` matches no day in the span. Callers
 * MUST treat that as a rejection rather than a range: with a denominator of
 * zero every account would roll up to fully complete by vacuous truth.
 */
export const rangeDays = ({ from, to, daysOfWeek }: TDateRange): string[] => {
  const total = countDhakaDaysInclusive(from, to);
  const wanted = daysOfWeek?.length ? new Set(daysOfWeek) : null;
  const days: string[] = [];

  for (let offset = 0; offset < total; offset += 1) {
    const date = addDhakaDays(from, offset);

    if (wanted && !wanted.has(civilDateWeekday(date))) continue;

    days.push(date);
  }

  return days;
};

/** The 0-is-Sunday weekday of an already-validated `YYYY-MM-DD` civil date. */
const civilDateWeekday = (date: string): number =>
  new Date(civilDateToUtcMs(date)).getUTCDay();

/** A validated period, in the form the services and repositories consume. */
export type TResolvedPeriod =
  { mode: 'date'; date: string } | ({ mode: 'range' } & TDateRange);

/**
 * Turns a validated `date` XOR `from`/`to` input into the tagged period every
 * downstream caller branches on.
 *
 * Deliberately does NOT collapse a single date into a one-day range. The two
 * produce different row shapes and answer different questions, and the tag is
 * what keeps a caller from having to infer which it received.
 */
export const resolvePeriod = (input: TDateOrRangeInput): TResolvedPeriod =>
  input.date !== undefined
    ? { mode: 'date', date: input.date }
    : {
        mode: 'range',
        from: input.from as string,
        to: input.to as string,
        daysOfWeek: input.daysOfWeek,
      };
