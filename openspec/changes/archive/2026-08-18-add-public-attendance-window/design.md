## Context

`BACKEND_REQUIREMENTS.md` lists four items the frontend needs. Three shipped in the archived `2026-08-17-daily-status-http-layer` change and are verified present in the tree: `src/modules/dailyStatus/` exists with all four files and is registered at `/api/daily-status` in `src/app.ts:43`; `attendance.validation.ts` already carries `/^[A-Za-z\s]+$/` with the English-only comment; and `grep -rn DAILY_STATUS_ENABLED` over `src/` and `.env*` returns nothing. Item 2 is the only one outstanding.

The pieces this change needs are already built and exported:

- `channelScheduleRepository.getOrCreateSchedule()` (`src/repositories/channelSchedule.repository.ts:52`) returns the single `key = 'DAILY_UPDATE'` row, creating it lazily with the defaults 18:00 / 23:59 / all seven days / enabled. It is already called from six places, so a seventh caller costs one indexed read.
- `isWithinWindow(schedule, instant?)` is **already exported** from `src/lib/scheduler/channelSchedule.scheduler.ts:79`. It checks `daysOfWeek.includes(getDhakaWeekday(instant))` and then `openTime <= now < closeTime` on `getDhakaTimeOfDay(instant)`. It deliberately does not consider `enabled` — the scheduler's callers check that separately.
- `src/utils/dhakaDate.ts` owns every Dhaka-time derivation: `DHAKA_TIMEZONE`, `getDhakaDate`, `getDhakaTimeOfDay` (`h23`, so midnight is `00:05` not `24:05`), `getDhakaWeekday` (0=Sunday, cron's numbering).

What does **not** exist is a Dhaka wall-clock → absolute instant conversion. `nextOpenAt` and `closesAt` are the first values in the system that need one; every other date in the attendance domain is a civil-date string precisely to avoid this conversion.

The constraint that shapes the whole design: this endpoint is loaded by every student opening the form. At ~5,000 members concentrated into an evening it is the highest-traffic route in the application, and it shares a process with the Discord bot that is simultaneously running member sync and pacing reminder DMs at 2/second.

## Goals / Non-Goals

**Goals:**

- One public, unauthenticated `GET /api/attendance/window` returning the nine-field projection, always 200.
- `isOpen` derived from stored schedule data and the Dhaka clock, with zero external I/O beyond one indexed database read.
- `nextOpenAt` / `closesAt` as correct absolute instants, produced inside `dhakaDate.ts`.
- Nothing admin-shaped in the response, structurally rather than by omission discipline.
- One definition of the window, shared with the channel scheduler and the announcement's `{{close_time}}`.

**Non-Goals:**

- Enforcing the window on `POST /api/attendance/submit`. Unchanged by this design; see Decision 6.
- Exposing the live Discord channel overwrite publicly. See Decision 2.
- Caching the schedule row in memory. See Decision 5.
- Any change to `/api/schedule/daily-update`, its auth, or its payload.
- Any schema change, migration, new environment variable, or new dependency.
- A per-timezone schedule. `Asia/Dhaka` stays a constant, reported and never accepted.

## Decisions

### 1. The route lives on `attendanceRouter`, not on a new router

`GET /api/attendance/window` is registered in `src/modules/attendance/attendance.routes.ts` beside `verify-user` and `submit`.

*Why:* that file already carries the header comment explaining that its routes are the only ones with no `auth()` and that anything added inherits that exposure — the exact warning the next person needs when they read this route. A separate public router would create a second place to hold that invariant, and the two would drift.

*Alternative rejected:* extending `scheduleRouter` with an unauthenticated sub-path. That router is `auth(ADMIN)` end to end; one exempt route inside it is precisely the shape of mistake that leaks `updatedBy` later.

### 2. `isOpen` is computed from the schedule, never read from Discord

`scheduleService.getSchedule()` calls `isDailyUpdateChannelOpen()`, which fetches the channel and reads the `@everyone` overwrite. The public service must not reuse it.

*Why:* one Discord REST call per student page load, against a bot that a rate-limit strike would also take offline for member sync and the attendance form's own membership check — the failure Golden Rule 4 exists to prevent. It is also the wrong question: the student submits through the web form, whose availability the schedule defines. The channel's live state answers "may I post a message in `#daily-update`", which is a different endpoint's business.

*Consequence, accepted deliberately:* an admin who manually locks the channel mid-window leaves the form reporting open. That is correct — the manual override targets the channel, and `POST /submit` does not consult the channel either.

### 3. `isOpen = enabled && isWithinWindow(schedule)`, reusing the scheduler's exported predicate

*Why:* the scheduler's boot reconcile decides whether the channel should be open using `isWithinWindow`. If the public endpoint reimplemented the comparison, the form could say "closed" during hours the channel is open, and nothing would raise an error — the two would simply disagree in a way only a student would notice. Reusing the exported function makes that divergence impossible.

`enabled` is ANDed on the outside because `isWithinWindow` deliberately ignores it (the scheduler treats "disabled" as "leave the channel alone", not "locked"). Here disabled means the form never opens, which the spec pins.

*Import direction:* `attendance.service.ts` → `lib/scheduler/channelSchedule.scheduler.ts`. That module already imports from repositories and `lib/discord`, and nothing in `lib/` imports from `modules/`, so no cycle is introduced. If the import ever feels wrong, the fix is moving `isWithinWindow` into `dhakaDate.ts` or a small `lib/schedule/window.ts` — not copying it.

### 4. Wall-clock → instant conversion goes into `dhakaDate.ts`, with the offset derived from `Intl`

Add to `src/utils/dhakaDate.ts`:

```ts
dhakaWallClockToInstant(date: 'YYYY-MM-DD', time: 'HH:mm'): Date
```

Implementation: interpret the wall clock as if it were UTC, ask `Intl.DateTimeFormat(DHAKA_TIMEZONE, { timeZoneName: 'longOffset' })` what Dhaka's offset is at that approximate instant, parse the `GMT±HH:MM` it returns, and subtract. Verified available on this runtime (Node 24 returns `GMT+06:00`).

*Why derive rather than hardcode `+06:00`:* Bangladesh has observed DST as recently as 2009 and has publicly revisited the idea since. A hardcoded offset would be a second, silent definition of the timezone sitting next to `DHAKA_TIMEZONE`, and if the zone ever gains a rule again, every other date in the system would follow the tz database while these two instants alone would not — a one-hour error in a displayed countdown, with nothing failing. Deriving keeps `DHAKA_TIMEZONE` the only place the zone is named.

*Why in `dhakaDate.ts`:* that module is documented as the only producer of Dhaka dates and times. A conversion living in a service would be the start of a second one.

*Alternatives rejected:* adding `date-fns-tz` or `luxon` — a dependency for one function the platform already provides. Constructing `new Date('2026-08-18T23:59:00+06:00')` — the same hardcoded offset with the problem hidden inside a template literal.

### 5. `nextOpenAt` is a bounded forward scan; no caching

Starting from today's Dhaka civil date, walk up to 8 candidate days. For each, skip it if its weekday is not in `daysOfWeek`; compute its opening instant; return the first one strictly after now. Eight rather than seven so that a schedule with a single day of week, already past today, resolves to next week's occurrence rather than to null.

Reported even while the window is open (it then names the *next* occurrence, matching the requirements document's own example, where `isOpen: true` sits beside a `nextOpenAt` of the following day). Null only when `enabled` is false.

*No caching of the schedule row.* One indexed single-row read per request is cheap, and a cache introduces a staleness window in which an admin's edit is visible in the dashboard and the channel but not in the form — exactly the divergence this endpoint exists to eliminate. If the read ever becomes a measured problem, a short TTL is a one-function change; adding it now would be speculative.

*Day arithmetic* runs on `Date.UTC(y, m-1, d + n)` over the parsed civil date and is reformatted through `getDhakaDate` — the same technique `getDhakaWeekday` already uses, so date rollover across month and year boundaries comes from the platform rather than from hand-written logic.

### 6. `POST /submit` is untouched

Submissions continue to be accepted at any hour. The window is a courtesy that saves a student filling in four fields at 3 a.m.

*Why not now:* a 4xx added here would start rejecting real submissions the moment it shipped, and the edge case is unsettled — a student who loads the form at 23:58 and submits at 00:01 must either be accepted and filed under the day the form was loaded, or refused with a message naming the deadline they missed. Silently filing it under the next day is the one outcome that is wrong. That decision deserves its own change, and the spec pins current behavior so a later change has to state it is altering it.

### 7. The projection is built explicitly, field by field

The service constructs the response object literally rather than spreading the schedule row and deleting keys.

*Why:* `getOrCreateSchedule()` returns `TChannelScheduleWithEditor` — it includes the `updatedBy` relation with the admin's name and email. A spread-and-omit would leak that the day someone adds a field to the row or to the include, on the one route reachable without a token. An explicit literal cannot: a new column is simply absent until someone writes it in. The `sendResponse` envelope stays standard so the form's client code matches the other two public routes.

### 8. A 60/min per-IP limiter, on the existing in-memory store

`attendanceWindowRateLimiter` is added to `src/middlewares/rateLimit.ts` with `windowMs: 60_000, limit: 60`, mirroring `verifyUserRateLimiter`.

*Why 60/min:* one page load issues one call. Sixty leaves ample room for reloads and for several students behind one NAT while still bounding an abusive client.

*Why the in-memory store:* the file already documents why the public limiters were deliberately not moved to Redis — a Redis outage on the path ~5,000 students submit through is not an acceptable failure mode, and that swap needs its own decision about fail-open versus fail-closed. Putting the newest public route on a different store would prejudge it.

*Trade-off, unchanged from the existing routes:* counters are process-local, so N replicas multiply the effective budget by N.

## Risks / Trade-offs

- **The form's reported hours could disagree with the channel's actual state.** → Accepted and specified. `isOpen` describes the form's hours; the channel is a separate mechanism with its own manual override. The alternative — a Discord call per page load — risks a rate-limit strike that takes down member sync and the membership check together.
- **`updatedBy` could leak through the new route.** → Decision 7's explicit projection, plus a spec scenario asserting no editor identity, scheduler state, or channel identifier appears in the response, plus a manual verification step on a schedule row that has a recorded editor.
- **The offset derivation could break on a runtime without `timeZoneName: 'longOffset'`.** → Verified on the deployment runtime (Node 24). The parse is defensive: an unexpected format falls back to the tz-database offset for Dhaka rather than throwing, and this route must never 500.
- **A forward scan bug could return null `nextOpenAt` for an enabled schedule.** → The 8-day bound guarantees a hit whenever `daysOfWeek` is non-empty, and an empty array is already rejected by `schedule.service.ts` (pausing is what `enabled: false` is for). Verified against a single-day schedule.
- **The route is now the highest-traffic path in the process.** → One indexed single-row read, no external I/O, and a per-IP limiter in front. Well within what the existing public endpoints already sustain.
- **A frontend gate that fails the wrong way would lock students out.** → Not introduced here: `frontend/lib/attendance-window.ts` already fails open and is pinned by `lib/attendance-window.test.ts`. Any backend outage yields the form as it renders today.
- **The count of unauthenticated routes changes from two to three.** → `CLAUDE.md` states the two-route fact explicitly; it is updated in the same change so the document does not start lying the moment this ships.

## Migration Plan

Additive only. No migration, no data backfill, no configuration.

1. Ship the route. It answers immediately; nothing else in the backend changes behavior.
2. The frontend gate activates on its own — `attendance-window.ts` returns `null` while the route 404s and starts gating the moment it answers. No frontend deploy to coordinate.
3. **Rollback** is removing the route (or reverting the commit). The frontend reverts to the ungated form on the next failed fetch; no state is left behind, because the endpoint writes nothing.

The one write-shaped side effect worth naming: on a brand-new deployment where no schedule row exists yet, the first call to this endpoint materializes the default row through `getOrCreateSchedule()`. That is the existing lazy-creation behavior of six other callers, and the defaults are the intended ones.

## Open Questions

None blocking. Two settled by decision rather than by consensus, recorded so a future reader knows they were considered:

- Whether `nextOpenAt` should be null while the window is open. Decided no — it names the next occurrence, matching the requirements document's example.
- Whether `POST /submit` should enforce the window. Decided out of scope; see Decision 6.
