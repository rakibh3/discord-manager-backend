## Why

The daily-status dashboard and the reminder broadcast both answer exactly one question: "what happened on this one Dhaka day". An admin who wants to see who has been falling behind over a week has to load seven pages and hold the pattern in their head, and there is no way at all to remind the students who are actually a problem — someone who missed a single day gets the same DM as someone who has submitted nothing in three days. Both features already derive "did this person do their work" from the same two tables in the same way; widening that derivation from a day to a span of days is what turns a daily checklist into something an admin can act on.

## What Changes

- `GET /api/daily-status`, `/counts`, `/export`, and `/members/:memberId` accept **either** a single `date` (unchanged) **or** a `from`/`to` pair. The two forms are mutually exclusive; supplying both, or `from` after `to`, is a 400.
- In range mode a dashboard row still describes ONE PERSON, but its status column becomes per-day counts — `daysInRange`, `attendanceDays`, `updateDays`, `completeDays`, `missedDays` — plus a rollup status of `ALL_COMPLETE`, `PARTIAL`, or `NONE`. Single-date mode keeps today's four-bucket `status` exactly as it is.
- Both the status filter and the reminder accept an optional `daysOfWeek` array (cron 0=Sunday numbering, the same numbering `channel_schedules` already uses) naming which weekdays inside the range count. Omitted means every calendar day counts. Nothing is inferred from the current channel schedule.
- `POST /api/reminders/send` and `GET /api/reminders/targets` accept `from`/`to` in place of `date`. A **missed day** for reminder purposes is a day the account submitted **neither** the attendance form **nor** a daily update — `MISSING_BOTH`, not "either one missing". An optional `minMissedDays` (default 1) is the threshold, so "missed two of the past three days" is a three-day range with `minMissedDays: 2`.
- **BREAKING (internal):** `reminder_logs.reminder_date` is replaced by `reminder_start_date` + `reminder_end_date`, and the run's criteria (`min_missed_days`, `days_of_week`) are persisted alongside the message. A single-date broadcast stores start = end. Existing rows are backfilled from `reminder_date` before the column is dropped.
- The one-broadcast-at-a-time guard changes from same-date equality to **range overlap**: a new broadcast is a 409 while any `PENDING`/`PROCESSING` run covers an overlapping span, because the constraint it protects (the bot's single global DM budget) is unchanged by widening the window.
- The reminder target list and the dashboard's missed-day count are derived from one shared repository query, so a person the dashboard shows as having missed two days is exactly a person the DM targets at `minMissedDays: 2`.

## Capabilities

### New Capabilities

_None._ Every behaviour here widens an existing capability rather than introducing a new surface.

### Modified Capabilities

- `daily-status-aggregation`: the aggregation gains a date-range mode producing per-person per-day counts and a rollup status, a `daysOfWeek` restriction on which days in the range count, and a range-and-threshold reminder target query keyed on days missing BOTH submissions.
- `daily-status-http`: all four dashboard endpoints accept a `from`/`to` pair as an alternative to `date`, plus `daysOfWeek`, and return the range row shape and range-wide counts.
- `reminder-broadcast`: a broadcast targets a range with a missed-day threshold rather than a single date; the conflict guard becomes overlap-based; the run records its criteria for audit.
- `attendance-data-model`: `ReminderLog` stores a start and end date and the criteria of the run instead of a single `reminderDate`.

## Impact

- **Schema / migration**: `prisma/schema/reminder.prisma` (`ReminderLog`), two migrations — one additive-and-backfill, one that enforces NOT NULL and drops `reminder_date`. `ReminderRecipient` is untouched.
- **Repositories**: `src/repositories/dailyStatus.repository.ts` (every `$queryRaw` in it), `src/repositories/reminder.repository.ts` (the log write, the active-run lookup, the history list).
- **Modules**: `src/modules/dailyStatus/*` (validation, service, controller) and `src/modules/reminder/*` (validation, service, controller).
- **Queue**: `src/lib/queue/reminder.queue.ts` / `reminder.worker.ts` read the reminder row for the message; the payload stays identity-only, so the job shape does not change.
- **API surface**: `postman-collection.json` and `API_INTEGRATION.md`.
- **Not affected**: `GET /api/attendance/window`, the public attendance endpoints, the channel scheduler, the announcement feature, member sync, and ingestion. No Discord API call count changes — the range is a database concern.
