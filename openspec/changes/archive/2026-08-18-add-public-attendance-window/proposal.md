## Why

The public attendance form is meant to be available only while submissions are open, and to say so plainly the rest of the time rather than presenting a form that leads nowhere. The window it must display is the `#daily-update` schedule row — the same row `{{close_time}}` is rendered from — but that row is readable only through `GET /api/schedule/daily-update`, which is `auth(ADMIN)`. Students are `discord_members` rows, not `users`; they have no credential and never will, so today the form has no way to learn its own hours.

`BACKEND_REQUIREMENTS.md` lists four items. Three are already shipped (the `daily-status` HTTP layer, the English-only name rule, and the dead `.env` line — all delivered by the archived `2026-08-17-daily-status-http-layer` change). This proposal covers the one that remains: item 2.

Three alternatives were considered and rejected, recorded here so they are not re-proposed:

- **Duplicating the times in frontend env.** An admin editing the schedule would change the channel and the announcement text while the form silently kept the old hours, with nothing anywhere showing the two had diverged.
- **Giving the Next.js server admin credentials.** That puts a full-privilege token on the one code path reachable without authentication, to read four fields.
- **Relaxing auth on `/api/schedule/daily-update`.** That payload carries `updatedBy` (admin name and email), `scheduler.lastRun.error` (internal failure strings) and the channel ID. None of it belongs to an anonymous caller.

## What Changes

- Add `GET /api/attendance/window` — a public, unauthenticated, deliberately thin projection of the `channel_schedules` row plus the current Dhaka clock. It joins `verify-user` and `submit` on `attendanceRouter`, the only routes in the application with no `auth()` middleware.
- The response carries exactly nine fields: `isOpen`, `date`, `openTime`, `closeTime`, `daysOfWeek`, `enabled`, `timezone`, `nextOpenAt`, `closesAt`. Nothing admin-shaped — no `updatedBy`, no `scheduler`, no `lastRun.error`, no channel ID.
- `isOpen` is computed from the **schedule** (`openTime`/`closeTime`/`daysOfWeek`/`enabled` against the Dhaka clock), never from a live read of the Discord channel overwrite. This endpoint is hit by every student loading the form — thousands of times in an evening — against a bot that is simultaneously syncing members and pacing reminder DMs.
- Add a per-IP rate limiter for the route, sized like `verify-user` (60/min), on the same process-local `express-rate-limit` store as the existing public limiters.
- Add a Dhaka wall-clock → instant helper to `src/utils/dhakaDate.ts`, so `nextOpenAt` and `closesAt` are produced by the one module that owns Dhaka time conversion rather than by ad-hoc arithmetic in a service.
- Always 200. This is a question with a routine answer, not an operation that can fail to find something.
- **No** change to `POST /api/attendance/submit`. It continues to accept a valid member's attendance at any hour; the window is a frontend courtesy, not an enforcement point. Making it one requires settling the 23:58-load / 00:01-submit case first and belongs in its own change.
- No new table, no migration, no Discord API call, no new environment variable.

## Capabilities

### New Capabilities

- `public-attendance-window`: The unauthenticated projection of the submission window — which fields are exposed, which are withheld, how `isOpen`/`nextOpenAt`/`closesAt` are derived from the stored schedule and the Dhaka clock, and the guarantee that serving it touches no external service.

### Modified Capabilities

- `public-endpoint-rate-limiting`: The set of endpoints reachable without credentials grows from two to three. The requirement that every such endpoint carries a per-IP budget now has a third instance, with its own budget sized to a page load rather than a form submission.

## Impact

**Code**

- `src/modules/attendance/attendance.routes.ts` — one new route, no `auth()`, with a limiter.
- `src/modules/attendance/attendance.controller.ts` — one new handler.
- `src/modules/attendance/attendance.service.ts` — the projection and the `isOpen` / `nextOpenAt` / `closesAt` derivation.
- `src/middlewares/rateLimit.ts` — one new limiter.
- `src/utils/dhakaDate.ts` — a Dhaka wall-clock → `Date` helper, plus the next-occurrence search it supports.
- `src/repositories/channelSchedule.repository.ts` — read-only reuse of `getOrCreateSchedule()`; unchanged.
- `src/lib/scheduler/channelSchedule.scheduler.ts` — read-only reuse of the exported `isWithinWindow()`; unchanged.

**API**

- New public endpoint `GET /api/attendance/window`. Additive only; no existing response shape changes.

**Documentation**

- `API_INTEGRATION.md` — new section beside the two existing public routes.
- `postman-collection.json` — new request.
- `CLAUDE.md` — the public-attendance-endpoints section currently states there are exactly two routes with no `auth()`; that count becomes three.

**Not affected**

- Database schema, migrations, Prisma models, the Discord bot, the schedulers, the reminder queue, and every authenticated route.

**Deployment**

- Nothing to configure and no frontend deploy to coordinate. `frontend/lib/attendance-window.ts` fails open: while the route 404s it returns `null` and the homepage renders the form exactly as it does now. The gate activates the moment the route answers and reverts to the open form on any backend outage. That direction is deliberate — the inverse would show ~5,000 students a "come back later" page during the exact hours they are meant to be submitting.
