# AGENTS.md

Express 5 + TypeScript + Prisma 7 (PostgreSQL) REST API running a Discord daily-attendance / update automation bot for **one or many identical Discord servers** from a single process. Admin-only auth; students submit via a public web form.

**Read `CLAUDE.md` first** — it is the authoritative, detailed reference for this repo (multi-server design, Discord bot, scheduler, reminder queue, announcements). This file is the condensed version.

## Commands

- Bun is the package manager (`bun.lock`), but scripts run through Node/tsx.
- `bun install` → `cp .env.example .env` → `docker compose up -d` (Postgres on host port 5433 by default + Redis) → `bunx prisma generate` → `bun run start:dev`
- `bunx prisma generate` is **required after every clone and every schema change**: the generated client lives in `generated/` which is **gitignored** — a fresh clone won't typecheck until it runs.
- No test framework is configured. Verification = `bun run lint` + `bun run build` (build runs `tsc`, the only typecheck) + `bun run format:check`.
- `bun run seed` creates the initial admin. `bunx prisma migrate dev --name <name>` for migrations.

## Prisma 7 setup (main source of surprises)

- Prisma config lives in `prisma.config.ts` (not package.json); schema is split across `prisma/schema/*.prisma` — adding a `.prisma` file there is enough to be picked up. Run `bunx prisma generate` after adding one.
- The datasource has **no `url`**; connection comes from the `@prisma/adapter-pg` driver adapter in `src/lib/prisma.ts`. Always import the shared `prisma` singleton from `@/lib/prisma`, and import types from `@generated/*` — **never** `@prisma/client`.
- Under the driver adapter, P2002's `err.meta.target` is `undefined`; the constraint name is at `meta.driverAdapterError.cause.constraint.fields`. `attendance.service.ts` matches on `JSON.stringify(err.meta)` — mirror that pattern for new P2002 handling.

## Multi-server architecture (read before touching guilds/channels/members)

- **There is no "the guild".** Servers come from positional env lists (`DISCORD_GUILD_IDS`, `ATTENDANCE_CHANNEL_IDS`, `DAILY_UPDATE_CHANNEL_IDS`, `REMINDER_CHANNEL_IDS`); entry N of every list is the same server. Never use a singular guild accessor — it silently serves one server.
- `discord_members` is keyed `(guild_id, discord_user_id)` and `(guild_id, discord_username)`; a person in two servers is **two rows**. Child tables (`Attendance`, `DailyUpdate`, `ReminderRecipient`) inherit the server via `memberId` — never add a second `guild_id` to them.
- **One Discord account = one person = one day's obligation.** Credit sources and dashboard aggregates key on `discord_user_id` with no `guild_id` / `is_in_guild` filter; a `guildId` filter selects *who is listed*, never what their counts are.
- **The departure guard in `reconcileDepartures` is load-bearing**: it counts and reconciles per `guildId` — unscoped, syncing server A marks every member of server B departed in one `updateMany`, locking B out of the attendance form silently. Never remove it or drop the scoping.
- Fan-out is sequential, attempts every server, never throws (`src/lib/discord/fanout.ts`). Partial failure = 200 with `data.summary.failed > 0`.
- When one server goes quiet, check `GET /api/discord/sync/status` first (channel-ID swaps are undetectable statically and are verified at ClientReady).

## Module pattern and layering

- Each feature in `src/modules/<name>/` is four files: `*.routes.ts` (validate + `auth(...roles)` middleware), `*.validation.ts` (Zod v4), `*.controller.ts` (wrapped in `catchAsync`, responds via `sendResponse`, **never touches Prisma**), `*.service.ts` (business rules, throws `AppError`). Register new routers in `src/app.ts`.
- Attendance-domain data access lives in `src/repositories/*.repository.ts` — not module services — because non-HTTP callers (Discord gateway, BullMQ worker) share it. Repositories never throw `AppError` or see `req`; a repository returning `null` and a service deciding it's a 404 are separate concerns.
- `src/lib/discord/` is the bot (not a module — gateway handlers aren't HTTP-scoped); `src/lib/queue/` is the BullMQ reminder queue; `src/lib/scheduler/` holds the cron tasks. `src/server.ts` wires: prisma → listen → start bot → on `onDiscordReady()` → schedulers.
- **`DiscordMember` ≠ `User`**: `discord_members` is the synced guild directory (never authenticates); `users` is the admin login. FKs to members are named `memberId`, never `userId`.

## Public attendance endpoints (security-sensitive)

- Only `GET /api/attendance/verify-user`, `POST /api/attendance/submit`, `GET /api/attendance/window` have no `auth()` middleware — deliberately, since students have no accounts. **Anything added to `attendanceRouter` inherits that public exposure.**
- `verify-user` answers 200 for an unknown handle, `submit` answers 404; format errors are 400 either way.
- `window` must never do a live Discord channel read — it's hit on every student page load and would exhaust the Discord rate limit.
- Client auth: raw `Authorization` header **without** a `Bearer ` prefix. Refresh tokens rotate; logout deletes the DB row.
- Rate limiters are intentionally in-memory (process-local); `TRUST_PROXY_HOPS` is an integer hop count, never `true` (caller-supplied `X-Forwarded-For` would bypass budgets).
- `DISCORD_USERNAME_REGEX` is deliberately permissive (`/^(?!.*\.{2})[a-z0-9_.]{2,32}$/`) — tightening it locks real students out of the form. Re-verify against synced members after touching it.

## Domain conventions

- Civil dates are **strings** `YYYY-MM-DD` (Dhaka calendar), wall-clock times are strings `HH:mm` — never `DateTime`. Only `src/utils/dhakaDate.ts` produces them (`Asia/Dhaka`, independent of server `TZ`); never slice an ISO string (yields UTC day).
- Duplicate prevention is DB constraints (`@@unique`), never read-then-write; P2002 is expected and handled centrally.
- Dashboard figures (total members, submitted, …) exist **only** in `getDailyStatusCounts` — a plain `prisma.attendance.count()` elsewhere disagrees silently.
- Raw SQL lives in `dailyStatus.repository.ts` with a comment listing every column it depends on — verify by hand after schema changes.
- `SIGINT`/`SIGTERM` shutdown is already wired; nothing to add. Auth cookies are dev-only (`secure: false, sameSite: 'none'`) — known pre-deployment caveat.
- The bot client is not exported; reach it via `getDiscordClient()` (it is rebuilt on degraded-intent retry). Upsert members on `discordUserId`, never username (handles are mutable). Departures are `isInGuild: false` + `leftAt` flags, never deletes.

## OpenSpec workflow

`openspec/` uses the spec-driven OpenSpec workflow — skills are available under `.claude/skills/` (propose → apply → sync → archive) and via the `opsx` command. Check `openspec/changes/` for an in-flight change before editing specs or related code.
