# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Express 5 + TypeScript + Prisma 7 (PostgreSQL) REST API for a Discord daily-attendance / update automation admin dashboard. Authentication is strictly for administrators (no regular user login/registration; students/members submit attendance directly via web form). Auth, user, the Discord bot / member-sync modules, the public attendance endpoints, `#daily-update` message ingestion, the admin-managed channel open/lock scheduler, and the rate-limited reminder DM queue exist. Still missing from the attendance domain: the dashboard endpoints (including the SSE progress stream that wraps the reminder progress read).

## Commands

Bun is the package manager (`bun.lock`); the scripts themselves still run through Node/tsx.

```bash
bun install
bun run start:dev      # tsx watch src/server.ts (dev server)
bun run build          # tsc && tsc-alias -f  (tsc-alias rewrites @/* paths in dist)
bun run start          # node ./dist/src/server.js
bun run seed          # tsx prisma/seed.ts (idempotently seed initial admin)
bun run lint           # eslint src prisma
bun run lint:fix
bun run format
bun run format:check

docker compose up -d   # PostgreSQL 16, reads POSTGRES_* from .env, host port 5433 by default

bunx prisma generate   # REQUIRED after clone and after any schema change
bunx prisma migrate dev --name <name>
bunx prisma studio
```

No test framework is configured.

## Prisma setup (the main source of surprises)

- **Config lives in `prisma.config.ts`**, not `package.json`. It points at the _directory_ `prisma/schema/` (split schema: `schema.prisma` holds generator + datasource, `auth.prisma` holds `User`/`RefreshToken`, `user.prisma` holds `Profile`, `discord.prisma` holds `DiscordMember`, `attendance.prisma` holds `Attendance`/`DailyUpdate`, `reminder.prisma` holds `ReminderLog`/`ReminderRecipient`, `schedule.prisma` holds `ChannelSchedule`). Adding a new `.prisma` file to that directory is enough for it to be picked up.
- The `prisma-client` generator outputs to **`generated/prisma`**, which is **gitignored**. A fresh clone will not typecheck until `bunx prisma generate` runs.
- Import generated types from the `@generated/*` alias (`@generated/prisma/client`, `@generated/prisma/enums`) — never from `@prisma/client`.
- The datasource block has **no `url`**; the connection is supplied at runtime by the `@prisma/adapter-pg` driver adapter in `src/lib/prisma.ts` (and by `prisma.config.ts` for CLI commands). Always use the shared `prisma` singleton from `@/lib/prisma`.

## Architecture

ESM (`"type": "module"`) with path aliases `@/*` → `src/*` and `@generated/*` → `generated/*`.

`src/server.ts` connects Prisma, listens, **then** starts the Discord bot (unawaited) and — once that login resolves and the gateway reports ready via `onDiscordReady()` — the channel scheduler, and registers `SIGINT`/`SIGTERM` shutdown; `src/app.ts` sets `trust proxy` (see below), wires CORS (credentials, origin = the `APP_URL` + `ATTENDANCE_FORM_URL` allowlist), JSON/urlencoded/cookie parsers, routers under `/api/auth`, `/api/users`, `/api/discord`, `/api/schedule`, and `/api/attendance`, then `notFoundRoute` and `globalErrorHandler` last.

### Module pattern

Each feature under `src/modules/<name>/` is four files with fixed roles, each exporting a single named object (`authService`, `userController`, …):

- `*.routes.ts` — composes `validateRequest(schema)` / `validateQuery(schema)` and `auth(...roles)` middleware, exports `<name>Router`.
- `*.validation.ts` — Zod v4 schemas. `validateRequest` validates `req.body`, `validateQuery` validates `req.query`.
- `*.controller.ts` — wrapped in `catchAsync`, reads `req.user`, returns via `sendResponse(res, { success, statusCode, message, data, meta? })`. All responses go through `sendResponse`; controllers never touch Prisma.
- `*.service.ts` — business rules; throws `AppError(statusCode, message)`. Owns Prisma directly for auth/user/discord, and delegates to `src/repositories/` for the attendance domain (see below).

New modules follow this shape and are registered in `src/app.ts`.

### Repository layer (`src/repositories/`)

Attendance-domain data access lives in `src/repositories/*.repository.ts`, not in a module service, because its callers are not all HTTP-scoped: daily-update ingestion runs in a Discord gateway handler and the reminder queue runs in a BullMQ worker. Both must share the same queries as the Express modules — the alternative is two drifting definitions of "has this member submitted today".

The rule: **controllers never touch Prisma; services own business rules and throw `AppError`; repositories own Prisma and nothing else** — no `AppError`, no HTTP status codes, no `req`. A repository returns data or `null`; deciding that a `null` is a 404 stays in the service.

- `attendance.repository.ts`, `dailyUpdate.repository.ts`, `reminder.repository.ts` — writes and per-member reads.
- `member.repository.ts` — `findActiveMemberByUsername`, the directory lookup behind form verification. Filters `isInGuild: true` in the query and returns `null` for both "no row" and "member left"; the collapse is deliberate, so the public endpoint cannot be used to confirm that someone used to be in the server. Expects an already-normalized handle and matches it exactly — never with `startsWith`/`contains`, which compile to SQL `LIKE`, where `_` is a single-character wildcard and would match most of the directory.
- `dailyStatus.repository.ts` — the dashboard aggregation, in `$queryRaw` because a computed status column is not expressible in Prisma's fluent API. Sort column and direction come from a closed `Prisma.sql` allowlist; every other value is a bound parameter.

Dashboard figures (total members, attendance submitted, …) belong **only** to `getDailyStatusCounts`. They interlock and must agree, so a convenience `count()` elsewhere is drift, not a shortcut — a plain `prisma.attendance.count()` would silently include departed members and disagree.

Because `$queryRaw` does not break at compile time when a column is renamed, each raw query lists the columns it depends on in a comment above it. Check those by hand after any schema change.

### Auth flow

- Login issues an access + refresh JWT, **persists the refresh token row in `refresh_tokens`**, and sets both as httpOnly cookies _and_ returns them in the body.
- `/api/auth/refresh-token` reads the refresh token from the cookie, checks the DB row and expiry, then **rotates** it (delete + create in one `$transaction`). Logout deletes the row.
- `src/middlewares/auth.ts` reads the **raw `Authorization` header with no `Bearer ` prefix** — clients send the bare token. It verifies the access JWT, reloads the user, rejects non-`ACTIVE` status, enforces `requiredRoles`, bumps `lastActiveAt`, and populates `req.user` (typed via the global Express `Request` augmentation declared in that file).
- Only `ADMIN` role exists (`UserRole.ADMIN` in Prisma and `UserRole = 'ADMIN'` in `src/interface/index.ts`). Regular users/students do not have user accounts.
- DB-row expiry for refresh tokens is hardcoded to 7 days in `auth.service.ts`, independent of `JWT_REFRESH_EXPIRES_IN`.

### The public attendance endpoints

`src/modules/attendance/` holds the **only two routes with no `auth()` middleware**: `GET /api/attendance/verify-user?username=…` and `POST /api/attendance/submit`. That is not an oversight — students are not `users` rows, so the form has no credential to present. Anything added to `attendanceRouter` inherits that exposure.

Two things replace authentication, and both must stay on every public route:

- **The membership check.** The handle must resolve to a member with `isInGuild: true`. `verify-user` is a UI affordance for the form's badge; **`submit` re-runs normalization, format validation, and the lookup itself** and never trusts that verify was called. Nothing forces a client to call it, and a member can leave the guild between the two requests. Golden Rule 3 is enforced on the write path, not in the browser. Both endpoints resolve the member through one shared service helper so the two definitions of "verified" cannot drift.
- **`src/middlewares/rateLimit.ts`.** Per-IP budgets — 60/min on `verify-user` (it fires on a debounce as the student types), 5/15min on `submit` (a legitimate student submits once a day). The store is `express-rate-limit`'s in-memory default, so counters are **process-local**: N processes multiply the effective budget by N. Redis now exists in the project (for the reminder queue) but these limiters were **deliberately left on the in-memory store** — see the reminder-queue section for why the two systems fail in opposite directions. The swap remains a one-file change.

Other rules:

- **`app.set('trust proxy', …)` takes an integer hop count from `TRUST_PROXY_HOPS`, never `true`.** With `true`, Express reads the leftmost `X-Forwarded-For` entry as the client IP — caller-supplied, so every budget becomes bypassable with a forged header. `config/index.ts` ignores any non-numeric value (including the literal `true`), leaving Express on the direct connection address. `express-rate-limit`'s `trustProxy` validation is left enabled so a bad setting surfaces as `ERR_ERL_PERMISSIVE_TRUST_PROXY`.
- **CORS is an explicit allowlist** built from `APP_URL` + `ATTENDANCE_FORM_URL`. The dashboard and the form are separate deployments. Never `'*'` or `origin: true` while `credentials: true` is set.
- **Response flags live inside `data`.** The PID sketches `verified` / `alreadySubmitted` at the top level, but `sendResponse` owns the envelope — the form reads `data.verified`.
- **`verify-user` answers 200 for an unknown handle**, `submit` answers 404. Not-found is the routine answer on the read path; it is a genuine failure on the write path. A format error is a 400 from Zod either way, and must stay a distinguishable outcome — the form uses the difference to tell the student what to fix.
- `validateRequest` validates `req.body`; **`validateQuery` is its sibling** for query-string input. It does not assign the parsed result back, because `req.query` is a getter under Express 5.
- **P2002 detection under the driver adapter**: `err.meta.target` is **`undefined`** with `@prisma/adapter-pg`. The constraint arrives at `meta.driverAdapterError.cause.constraint.fields`, a driver-specific path that is not part of Prisma's documented contract. `attendance.service.ts` therefore matches on `JSON.stringify(err.meta)` containing `attendance_date`. Reading `meta.target` fails **silently** — the duplicate falls through to the generic "Duplicate Error" instead of the message naming the date. Check this if any P2002 handling is added elsewhere.

### Discord bot & member sync

Runs **in the same process as Express**, under `src/lib/discord/` (not a module, because the gateway event handlers are not HTTP-scoped):

- `client.ts` — the shared `Client` (`Guilds` + `GuildMembers` + `GuildMessages` + `MessageContent`), `startDiscordBot()` / `stopDiscordBot()`, and all `Events.*` registrations. **Never throws**: a bad token, a missing config value, or an unreachable guild is logged and the REST API keeps serving. The client is **not exported** — reach it via `getDiscordClient()`, because the degraded-intent retry replaces the instance (see below).
- `member.sync.ts` — full `guild.members.fetch()` sync, chunked 200-per-`$transaction`, plus the module-level sync state that `/api/discord/sync/status` reports.
- `message.ingest.ts` — `#daily-update` ingestion: resolve author → repair directory if needed → store → react ✅.
- `member.mapper.ts`, `events/*.ts` — `GuildMember` → DB payload, and the five live listeners (`guildMemberAdd`, `guildMemberRemove`, `guildMemberUpdate`, `userUpdate`, `messageCreate`).

Rules that matter:

- **`DiscordMember` ≠ `User`.** `discord_members` is the synced guild directory and never authenticates; `users` is the ADMIN login account. Attendance/daily-update FKs belong on `DiscordMember` and are named `memberId` — never `userId`, which would read as pointing at `users`. The PID's schema listing calls its member model `User`; that entity is `DiscordMember` here, so PID SQL must be transcribed, not copied.
- **Upsert on `discordUserId`, never on `discordUsername`.** Discord handles are mutable, so upserting on username creates a duplicate row on every rename. `upsertMemberPayload()` also handles the P2002 case where a member renames onto a handle another row still holds.
- **Departure flags, never deletes** — `isInGuild: false` + `leftAt`, so attendance history keeps a valid owner. Query `where: { isInGuild: true }` when you mean "currently in the server".
- **The departure guard**: if a member fetch returns 0 non-bots, or under 50% of the stored active count, the reconcile is skipped and logged loudly. Never remove it — without it a truncated fetch marks the whole directory departed in one `updateMany`, locking every student out of the attendance form. It is load-bearing in two directions. For the dashboard: every query in `dailyStatus.repository.ts` filters on `isInGuild`, so a mass-flagging would silently shrink the completion-rate denominator and empty the reminder target list, with no error raised anywhere. And for the student-facing form: `member.repository.ts` filters the same way, so a mass-flagging makes `verify-user` answer "not a member" for **everyone** and locks the whole server out of submitting — a total outage that raises no error, only a collapse in verification success rate.
- **Both privileged intents** (Server Members, Message Content) must be ON in the Discord Developer Portal. With either off, Discord rejects the connection outright (`Used disallowed intents`) rather than returning a partial feed.
- **A missing Message Content intent must never take down member sync.** Because Discord refuses the whole connection, requesting `MessageContent` would otherwise couple ingestion to the member directory — and the directory is what the public attendance form's membership check reads, so one wrong portal checkbox would lock ~5,000 students out of submitting. `startDiscordBot()` therefore catches the `disallowed intents` rejection, rebuilds the client **without** `MessageContent`, and retries login **exactly once**. Member sync lives; ingestion is off. Intents are fixed at construction in discord.js, which is why the client is a rebuildable binding behind `getDiscordClient()` and why `handlersRegistered` is reset on rebuild — handlers must attach to the client that actually logged in.
- **Degraded mode is silent by nature**, so it is reported: `GET /api/discord/sync/status` returns `dailyUpdate.ingestionEnabled` + `reason`. Without that field the only symptom is a month of missing daily updates and a dashboard showing every member as `MISSING_UPDATE`. Check it first when updates stop appearing.
- Channel and guild IDs always come from `.env` (`src/config/discord.ts`, Zod-validated as 17–20 digit snowflakes). Never key logic off a channel name.

### Daily-update ingestion (`messageCreate`)

`events/messageCreate.ts` holds only the cheap filters that need the raw `Message` — configured guild, `DAILY_UPDATE_CHANNEL_ID`, non-bot author, `MessageType.Default`/`Reply`, non-empty. `message.ingest.ts` owns everything after that, so the part worth reasoning about is free of a live gateway object.

- **Resolve the author by snowflake, never by handle.** PID §9 sketches "normalize `message.author.username`, then upsert" — do not follow it. Handles are mutable, so a student who renamed since the last sync would lose their update or have it credited to whoever now holds the old handle. `memberRepository.findMemberByDiscordUserId(message.author.id)` is the path.
- **That lookup deliberately does not filter `isInGuild`**, unlike `findActiveMemberByUsername` and every other read of the directory. Do not "fix" the asymmetry: the two answer different questions. The form asks "may this person submit _now_?" — a departed member must be refused. Ingestion asks "_whose_ message is this?" — someone who posted at 23:00 and left at 23:30 still owns it, and filtering would silently drop their update.
- **Unknown author ⇒ repair the directory, then ingest.** The initial ~5,000-member sync is not awaited at `ClientReady` and takes tens of seconds, so a student can post before the directory knows them. On a miss, `message.ingest.ts` fetches the member and writes them through `upsertMemberPayload()` — the same path member sync uses, carrying the username-collision tombstoning and reactivate-on-rejoin. Never `discordMember.create` directly; that would be a second write path that drifts. The repair must precede the insert, since `memberId` is a required FK. If the fetch fails, the message is dropped and logged — inventing a placeholder member row would poison the dashboard's denominators.
- **`messageDate` comes from `getDhakaDate(message.createdAt)`, never from now**, and `messageCreatedAt` stores the send instant. This matters most exactly when the system is busiest — the 23:5x rush before the channel locks, where a message queued behind a slow write would otherwise be filed under the wrong day.
- **✅ only on first write.** `createDailyUpdate` returns `{ record, created }` for this; a replayed gateway event resolves to the existing row and is not re-acknowledged. The reaction is best-effort and fires _after_ the write: the row is the source of truth, and a missing ✅ is cosmetic while a missing row marks a student absent.
- **Attachment-only messages are ingested** (empty `message`, non-null column) — a screenshot with no caption is still an update. Messages with no content _and_ no attachments/embeds are skipped, which also backstops the degraded case: without `MessageContent` every message arrives empty, so the filter yields nothing ingested rather than thousands of blank rows that look real to the dashboard.
- **Edits and deletes are not handled.** The stored row is the message as originally sent — an audit record.
- Nothing here throws. A gateway listener has no request to fail, so every step is wrapped and logged; `message.ingest.ts` contains no `AppError` and no HTTP status codes.

### Channel scheduler (`#daily-update` open / lock)

The submission window is enforced by the channel's own permissions, not by a time check in ingestion — ingestion deliberately stores whatever arrives, so these two must never both try to own the window. `src/lib/scheduler/channelSchedule.scheduler.ts` holds the `node-cron` tasks; `src/lib/discord/channel.state.ts` is the **only** module that edits the channel's permission overwrite; `src/modules/schedule/` exposes it at `/api/schedule` (all routes `auth(ADMIN)`).

- **The schedule is data, not code.** `channel_schedules` holds one row (`key = 'DAILY_UPDATE'`), created lazily by `getOrCreateSchedule()` with the PID defaults 18:00 / 23:59 / all seven days / enabled. There is no seed step. The cron expression is **derived** at registration (`<mm> <HH> * * <days>`) and never stored — an admin edits a time picker, never a cron string, because a mistyped `0 6 * * *` produces a job that fires happily at the wrong hour with no error anywhere.
- **`openTime` / `closeTime` are `String` `HH:mm`**, for the same reason the civil-date columns are strings: a `DateTime` can be shifted by a driver or the server's `TZ`, and these are wall-clock times, not instants. They compare and sort lexicographically, which is what makes the window check a plain string comparison.
- **There is no timezone column.** `Asia/Dhaka` is the `DHAKA_TIMEZONE` constant, reported in the API payload and never accepted from a client. A schedule in another zone would open the channel out of step with the day boundary every attendance row is filed under.
- **The window may not cross midnight** — `closeTime` must be strictly greater than `openTime`, checked in the service against the **merged** result of the patch, not the submitted fields alone. A lone `{ closeTime: "02:00" }` against a stored 18:00 is a 400. Reason: a message posted at 00:30 gets the _next_ day's `message_date` (correctly), so its author would read as missing on the day they actually submitted.
- **`daysOfWeek` is `Int[]` using cron's own 0=Sunday numbering**, so one array feeds both the cron expression and the boot reconcile. An empty array is rejected — pausing is what `enabled: false` is for.
- **Boot reconcile is silent.** `startChannelScheduler()` compares the window against the live overwrite and corrects a mismatch with `announce: false`. Never make it announce: a container restarting five times during a deploy would post five "🟢 Channel is OPEN" embeds to a channel thousands of students read. A restart at 8 PM otherwise leaves the channel locked all evening with no error raised anywhere.
- **Channel state is read from Discord, never cached.** `isDailyUpdateChannelOpen()` reads the live `@everyone` overwrite. An admin can flip it by hand in the client, and a stored flag would make the reconcile skip a correction it should have made.
- **Lock toggles `SendMessages` only** — `ViewChannel` is untouched, so a locked channel is read-only, not hidden.
- **`destroy()` the tasks on reload, never `stop()`.** A stopped task retains its old cron expression; restarted later it fires on a schedule nobody can see in the database.
- **`SCHEDULER_ENABLED` gates the timed jobs per process.** `node-cron` is in-process, so N replicas fire N times — the permission edit is idempotent but each replica posts its own embed. Unset means true. Same class of constraint as the process-local rate-limit store, and the same fix later: Phase 6's Redis makes BullMQ repeatable jobs a real distributed option. The manual endpoints and the status read work on **every** replica; only cron and the boot reconcile are gated.
- **The bot needs `Manage Roles` on the channel.** Without it every open and lock fails with `DiscordAPIError[50013]` and the window is simply never enforced. That is why the failure is reported on `GET /api/schedule/daily-update` as `scheduler.lastRun.error` rather than only logged — check it first when the channel stops opening.
- Nothing in the scheduler throws past its own boundary; failures are recorded in the in-memory `lastRun` (alongside `getSyncState()` / `getIngestionState()` in spirit) and the next day's job stays registered. `AppError` appears only in `schedule.service.ts`, which does have a request to fail.
- The bot's own announcement embeds are excluded from ingestion by the existing bot-author filter — no `daily_updates` row is created for them.

### Reminder DM queue (BullMQ + Redis)

The post-midnight reminder to members who missed a daily update. `src/lib/queue/` holds the connection, queue, and worker; `src/lib/discord/dm.ts` is the **only** module that sends a DM or writes to `#daily-update-reminder`; `src/modules/reminder/` exposes it at `/api/reminders` (all routes `auth(ADMIN)`).

- **One job is one recipient.** Never a single job looping over the target list with a sleep — that puts a 40-minute unit of work in one job, and anything that interrupts it (deploy, crash, OOM) makes BullMQ's stall detection re-run the whole thing from the start, re-DMing everyone already reminded. One job per member makes the unit of retry the unit of work.
- **The rate limiter is the point.** `limiter: { max: REMINDER_DM_PER_SECOND, duration: 1000 }`, default 2, clamped to 1–5 in `config/index.ts`. Golden Rule 4: Discord bans a bot that bursts DMs, and because the bot shares this process that ban also stops member sync and the attendance form's membership check. ~5,000 members takes ~40 minutes; that is the trade, not a bug to tune away.
- **The limiter's counter lives in Redis**, so it is shared across every worker on the queue. Unlike `SCHEDULER_ENABLED` — where a second replica genuinely doubles the announcements — `REMINDER_WORKER_ENABLED` is operational, not load-bearing: two workers still deliver inside one budget.
- **The job payload is identity only** (`reminderId`, `memberId`, `discordUserId`); the message is read from the `reminder_logs` row inside the job, so the text delivered and the text audited cannot diverge.
- **`jobId` may not contain `:`.** BullMQ rejects a custom id containing a colon (its own Redis key separator), so the deterministic id is `<reminderId>__<memberId>`. Discovered the hard way: it throws at `addBulk`, after the session and recipient rows are already written.
- **Error-code table** (`dm.ts`, the single place to change it): `50007` closed DMs → `DM_CLOSED`, **job succeeds**; `10013` unknown user and missing access/permissions → `FAILED`, job succeeds; `429` → `worker.rateLimit()` + `Worker.RateLimitError()`, which returns the job to `wait` **without** consuming an attempt; 5xx/network/timeout → throw, retried 3× with exponential backoff. A closed DM is a fact about that member, not a failure — throwing would burn three retries against a condition that cannot change and leave a "failed" job that is really a successful determination.
- **At-least-once, narrowed on purpose.** Three layers stand between a retry and a duplicate DM: the deterministic `jobId`, the `(reminder_id, member_id)` unique key, and the job's pre-send re-read of the recipient row. The residual window — DM sent, process died before the outcome write — is accepted. The inverse (record first, send second) would mark members as reminded who never were, which is worse for a feature whose purpose is reaching them.
- **Drain is detected in the database, behind a claim.** BullMQ's `drained` is queue-wide and says nothing about a specific broadcast, so each job counts that reminder's still-`PENDING` recipients. Two jobs can both see zero, so `finalizeReminderLog()` is an `updateMany` scoped to `status: PROCESSING`; only the caller that wins the claim posts the fallback. Without it a channel thousands of students read gets two mass mentions.
- **`markReminderProcessing` is scoped to `PENDING`** for the same class of reason: as a plain `update` it would rewrite `startedAt` on every one of ~5,000 jobs, and — far worse — flip a `CANCELLED` broadcast back to `PROCESSING` on the next queued job, defeating cancel entirely.
- **Cancel is the session status, not job removal.** A job already `active` cannot be removed and removal races the worker, so the worker re-reads the session before every send. `removeReminderJobs()` is an optimisation that spares Redis thousands of no-ops. Recipients never attempted stay `PENDING` — that is accurate, and why `CANCELLED` is its own `ReminderStatus` rather than a reuse of `FAILED`.
- **The fallback can never become a mass ping.** Every message in `announceClosedDms` sets `allowedMentions: { parse: [], users: <ids in this chunk> }`. `parse: []` makes `@everyone`, `@here`, and role pings structurally impossible from that path regardless of surrounding text. Chunked at 50 mentions to stay inside Discord's 2,000-character limit.
- **The bot needs `Send Messages` on `#daily-update-reminder`.** Without it every DM still delivers and the fallback silently reaches nobody — the members who most needed it. Reported as `lastFallback` on `GET /api/reminders/status`; check it there first.
- **`date` on `POST /send` is required and never inferred.** The run happens just after midnight where "yesterday" is nearly always right, but an inferred date on an irreversible mass DM would remind the wrong day's members with nothing looking wrong. A second broadcast for a date whose run is still `PENDING`/`PROCESSING` is a 409, so a double-click cannot queue a second 40-minute blast; after one finishes, a new one is allowed and recomputes its targets.
- **Redis is a dependency of this feature and nothing else.** `connection.ts` logs and swallows every error (an unhandled ioredis `error` event kills the process), `maxRetriesPerRequest: null` is required for worker connections, and the connection-failure log is throttled to one line per 30s because the retry loop never gives up. With Redis down the API, bot, ingestion, and scheduler all run normally and only broadcasts are refused with a 503 naming Redis.
- **The public rate limiters were deliberately NOT moved onto Redis**, even though `rateLimit.ts` names Phase 6 as the moment that becomes possible. The two fail in opposite directions: a Redis outage that stalls reminders is an inconvenience, the same outage on the path ~5,000 students submit through is not. That swap needs its own change and its own decision about fail-open vs fail-closed.
- Nothing under `src/lib/queue/` or in `dm.ts` throws past its own boundary except deliberately — a throw is how a job asks BullMQ to retry. `AppError` appears only in `reminder.service.ts`, which has a request to fail.

### Dates and the attendance domain

- **Civil dates are `String` in `YYYY-MM-DD`, never `DateTime`.** `attendance_date`, `message_date`, and `reminder_date` are Dhaka calendar dates, not instants. A `DateTime` column round-trips through a timezone-carrying JS `Date` and can shift a 23:58 Dhaka submission onto the wrong day; a string cannot be silently shifted by a driver. The format sorts and range-scans correctly, so month ranges are plain string comparisons.
- **Wall-clock times come from the same module.** `getDhakaTimeOfDay()` (`HH:mm`, `hourCycle: 'h23'` so five past midnight is `00:05` and not `24:05`) and `getDhakaWeekday()` (0=Sunday, computed from `getDhakaDate` rather than a localized weekday name) exist for the scheduler's "is now inside the window" decision. Never `Date.getDay()` — at 01:00 Tuesday in Dhaka a UTC server still says Monday, and the reconcile would check the wrong day's schedule.
- **`src/utils/dhakaDate.ts` is the only producer of those dates.** `getDhakaDate(instant?)` uses `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' })` and is independent of the server's `TZ` (verified under `TZ=UTC` and `TZ=America/New_York`). Never slice an ISO string — that yields the UTC day. Pass an explicit instant when the day is not "now": a daily update belongs to the day its **message was sent**, and a reminder run just after midnight targets the day that already closed. `isValidDhakaDate` / `dhakaDateSchema` guard the column, which Postgres would otherwise let hold anything.
- **Duplicate prevention is a database constraint, never a read-then-write check** (`@@unique([memberId, attendanceDate])`, `@unique` on `discord_message_id`, `@@unique([reminderId, memberId])`). A prior existence check does not survive concurrency; two simultaneous submissions would both pass it. P2002 is expected and handled centrally.
- `ReminderLog.sentCount` / `failedCount` are an incrementing cache for the progress bar; `reminder_recipients` is the source of truth. `finalizeReminderLog()` recomputes both from the recipient rows so a crashed worker cannot leave them permanently wrong, and `GET /api/reminders/:id` reads the recipient rows rather than the cache.

### Error handling

`src/errors/globalErrorHandler.ts` is the single response formatter. It branches on `ZodError` → `AppError` → `Prisma.PrismaClientValidationError` → known request codes (P2002 duplicate, P2023 cast, P2025 not-found, P2003 FK) → unknown/init errors → generic fallback, delegating shape to the small handlers in `src/errors/*Error.ts`. Stacks are only included when `NODE_ENV=development`.

Because P2025 is handled centrally, services use `findUniqueOrThrow` rather than manual not-found checks.

## Caveats

- Auth cookies are set with `secure: false, sameSite: 'none'`, which browsers reject — dev-only settings that need fixing before deployment.
- **`handleZodValidationError` title-cases every word** of every validation message (`str.replace(/\b\w/g, …)` in `src/errors/zodError.ts`), so a carefully written sentence comes back as "Enter A Valid Discord Username: 2-32 Characters …". It affects every endpoint's validation messages, not just the attendance ones. Fixing it changes existing response text, so it has been left alone; be aware that the message a client sees is not the string in the schema.
- `postman-collection.json` documents the API with `baseUrl` configured to `http://localhost:8000/api`.
- **`DISCORD_USERNAME_REGEX` must never be tightened to forbid a leading or trailing `_` / `.`.** The PID originally specified `/^(?![_.@])(?!.*\.{2})[a-z0-9_.]{2,32}(?<![_.])$/`, which rejected 115 of 2189 live members (5.3%) — `itzazad_`, `.rabbil`, `shahriarratul.`. Snowflake timestamps proved 59 of those accounts postdate Discord's Pomelo rollout, so the handles are current and valid, not grandfathered. The regex is now `/^(?!.*\.{2})[a-z0-9_.]{2,32}$/` and is verified against every synced member. Re-run that check after any change to it: tightening it locks real students out of the attendance form, violating Golden Rule 3.
