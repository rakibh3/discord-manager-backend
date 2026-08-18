## 1. Dhaka wall-clock → instant conversion

- [x] 1.1 Add `dhakaWallClockToInstant(date: string, time: string): Date` to `src/utils/dhakaDate.ts` — interpret `YYYY-MM-DD` + `HH:mm` as if UTC, derive Dhaka's offset at that approximate instant via `Intl.DateTimeFormat(DHAKA_TIMEZONE, { timeZoneName: 'longOffset' })`, parse the `GMT±HH:MM` value, and subtract it
- [x] 1.2 Make the offset parse defensive — an unexpected `timeZoneName` format falls back to the tz-database offset for Dhaka rather than throwing, since the calling route must never 500
- [x] 1.3 Add `addDhakaDays(date: string, days: number): string` to the same module, using `Date.UTC(y, m - 1, d + days)` reformatted through `getDhakaDate`, matching the technique `getDhakaWeekday` already uses so month and year rollover come from the platform
- [x] 1.4 Document both with the module's existing comment style: why the offset is derived rather than hardcoded to `+06:00` (Bangladesh has observed DST as recently as 2009; a hardcoded offset is a second silent definition of the zone alongside `DHAKA_TIMEZONE`)
- [x] 1.5 Verify by hand: `dhakaWallClockToInstant('2026-08-18', '23:59')` is `2026-08-18T17:59:00.000Z`, and the result is unchanged under `TZ=UTC` and `TZ=America/New_York`
- [x] 1.6 Verify `addDhakaDays('2026-12-31', 1)` is `'2027-01-01'` and `addDhakaDays('2026-02-28', 1)` is `'2026-03-01'`

## 2. Window projection in the attendance service

- [x] 2.1 Add `getAttendanceWindow()` to `src/modules/attendance/attendance.service.ts`, reading the row via `channelScheduleRepository.getOrCreateSchedule()`
- [x] 2.2 Compute `isOpen` as `schedule.enabled && isWithinWindow(schedule)`, importing the already-exported `isWithinWindow` from `@/lib/scheduler/channelSchedule.scheduler` — do not reimplement the comparison, and do not call `isDailyUpdateChannelOpen()`
- [x] 2.3 Comment the `enabled &&` — `isWithinWindow` deliberately ignores `enabled` because the scheduler treats disabled as "leave the channel alone", whereas here disabled means the form never opens
- [x] 2.4 Compute `closesAt` as `dhakaWallClockToInstant(today, schedule.closeTime)` when `isOpen` is true, and `null` otherwise
- [x] 2.5 Compute `nextOpenAt` by scanning up to 8 forward days from today's Dhaka date: skip days whose weekday is not in `daysOfWeek`, take each candidate's opening instant, and return the first strictly after now — 8 rather than 7 so a single-day schedule already past today resolves to next week
- [x] 2.6 Return `null` for `nextOpenAt` when `schedule.enabled` is false, and only then
- [x] 2.7 Build the response as an explicit object literal with exactly `isOpen`, `date`, `openTime`, `closeTime`, `daysOfWeek`, `enabled`, `timezone`, `nextOpenAt`, `closesAt` — never a spread of the schedule row, which carries the `updatedBy` relation with the admin's name and email
- [x] 2.8 Comment that the explicit literal is the leak barrier: a spread-and-omit would expose any field later added to the row or the include, on the one route reachable without a token
- [x] 2.9 Set `timezone` from the `DHAKA_TIMEZONE` constant — reported, never accepted from the caller
- [x] 2.10 Export the function from the `attendanceService` object

## 3. Rate limiter

- [x] 3.1 Add `attendanceWindowRateLimiter` to `src/middlewares/rateLimit.ts` with `windowMs: 60 * 1000, limit: 60`, mirroring `verifyUserRateLimiter`
- [x] 3.2 Comment the sizing (one call per page load; 60/min covers reloads and several students behind one NAT) and note it stays on the in-memory store for the reason the file already documents — a Redis outage on the students' submission path is not an acceptable failure mode, and that swap needs its own decision

## 4. Controller and route

- [x] 4.1 Add `getAttendanceWindow` to `src/modules/attendance/attendance.controller.ts`, wrapped in `catchAsync`, returning through `sendResponse` with `statusCode: httpStatus.OK` and message `'Attendance window retrieved successfully'`
- [x] 4.2 Register `GET /window` on `attendanceRouter` in `src/modules/attendance/attendance.routes.ts` with `attendanceWindowRateLimiter` and **no** `auth()` middleware and no validation middleware (the endpoint reads no parameters)
- [x] 4.3 Extend the router's header comment so the third public route is covered by the same warning, and state that this one has no membership check because it exposes no member data
- [x] 4.4 Confirm route ordering does not shadow anything — `/window` is a literal path and `attendanceRouter` declares no parameterized routes

## 5. Verification against a running backend

- [x] 5.1 `GET /api/attendance/window` **without** a token → 200 with all nine fields
- [x] 5.2 The body carries no `updatedBy`, no `scheduler`, no `lastRun`, and no channel or guild ID — check against a schedule row that has a recorded editor
- [x] 5.3 Inside the window: `isOpen` is `true`, `closesAt` is set and later than now, `nextOpenAt` names the *next* occurrence rather than the one in progress
- [x] 5.4 Outside the window: `isOpen` is `false`, `closesAt` is `null`, `nextOpenAt` is set
- [x] 5.5 With `{ "enabled": false }` saved on the schedule → `enabled: false`, `isOpen: false`, `nextOpenAt: null`, `closesAt: null`
- [x] 5.6 With a `daysOfWeek` excluding today → `isOpen: false` and `nextOpenAt` on the nearest scheduled future day
- [x] 5.7 With a single-element `daysOfWeek` set to a weekday already past this week → `nextOpenAt` falls in the following week, not `null`
- [x] 5.8 Change `closeTime` through `PATCH /api/schedule/daily-update` and confirm the next window response reports it, with no restart
- [x] 5.9 Call the endpoint repeatedly with the bot logs open and confirm **no** Discord API traffic is produced
- [x] 5.10 Exceed 60 calls in a minute from one address → 429 in the standard envelope; a different address is unaffected
- [x] 5.11 `POST /api/attendance/submit` still succeeds for a verified member while `isOpen` is `false`
- [x] 5.12 Manually lock the channel inside the window and confirm `isOpen` still reports `true` — the documented, intended divergence
- [x] 5.13 `bun run lint` and `bun run build` both pass

## 6. Documentation

- [x] 6.1 Add the endpoint to `API_INTEGRATION.md` beside the two existing public routes (§8.6), with the full response shape and the note that `isOpen` is the schedule window rather than the live channel state
- [x] 6.2 Add the request to `postman-collection.json` under the attendance folder, with no auth header
- [x] 6.3 Update `CLAUDE.md`: the public-attendance-endpoints section states there are exactly two routes with no `auth()` — make it three, and record why `isOpen` must never become a live channel read
- [x] 6.4 Mark item 2 done in `BACKEND_REQUIREMENTS.md` and note that items 1, 3 and 4 were delivered by the archived `2026-08-17-daily-status-http-layer` change
