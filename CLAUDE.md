# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Express 5 + TypeScript + Prisma 7 (PostgreSQL) REST API for a Discord daily-attendance / update automation admin dashboard. Authentication is strictly for administrators (no regular user login/registration; students/members submit attendance directly via web form). Auth, user, and the Discord bot / member-sync modules exist; the attendance domain is not built yet.

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

- **Config lives in `prisma.config.ts`**, not `package.json`. It points at the _directory_ `prisma/schema/` (split schema: `schema.prisma` holds generator + datasource, `auth.prisma` holds `User`/`RefreshToken`, `user.prisma` holds `Profile`, `discord.prisma` holds `DiscordMember`). Adding a new `.prisma` file to that directory is enough for it to be picked up.
- The `prisma-client` generator outputs to **`generated/prisma`**, which is **gitignored**. A fresh clone will not typecheck until `bunx prisma generate` runs.
- Import generated types from the `@generated/*` alias (`@generated/prisma/client`, `@generated/prisma/enums`) — never from `@prisma/client`.
- The datasource block has **no `url`**; the connection is supplied at runtime by the `@prisma/adapter-pg` driver adapter in `src/lib/prisma.ts` (and by `prisma.config.ts` for CLI commands). Always use the shared `prisma` singleton from `@/lib/prisma`.

## Architecture

ESM (`"type": "module"`) with path aliases `@/*` → `src/*` and `@generated/*` → `generated/*`.

`src/server.ts` connects Prisma, listens, **then** starts the Discord bot (unawaited) and registers `SIGINT`/`SIGTERM` shutdown; `src/app.ts` wires CORS (credentials, origin `APP_URL`), JSON/urlencoded/cookie parsers, routers under `/api/auth`, `/api/users`, and `/api/discord`, then `notFoundRoute` and `globalErrorHandler` last.

### Module pattern

Each feature under `src/modules/<name>/` is four files with fixed roles, each exporting a single named object (`authService`, `userController`, …):

- `*.routes.ts` — composes `validateRequest(schema)` and `auth(...roles)` middleware, exports `<name>Router`.
- `*.validation.ts` — Zod v4 schemas validating **`req.body` only**.
- `*.controller.ts` — wrapped in `catchAsync`, reads `req.user`, returns via `sendResponse(res, { success, statusCode, message, data, meta? })`. All responses go through `sendResponse`; controllers never touch Prisma.
- `*.service.ts` — all Prisma access and business rules; throws `AppError(statusCode, message)`.

New modules follow this shape and are registered in `src/app.ts`.

### Auth flow

- Login issues an access + refresh JWT, **persists the refresh token row in `refresh_tokens`**, and sets both as httpOnly cookies _and_ returns them in the body.
- `/api/auth/refresh-token` reads the refresh token from the cookie, checks the DB row and expiry, then **rotates** it (delete + create in one `$transaction`). Logout deletes the row.
- `src/middlewares/auth.ts` reads the **raw `Authorization` header with no `Bearer ` prefix** — clients send the bare token. It verifies the access JWT, reloads the user, rejects non-`ACTIVE` status, enforces `requiredRoles`, bumps `lastActiveAt`, and populates `req.user` (typed via the global Express `Request` augmentation declared in that file).
- Only `ADMIN` role exists (`UserRole.ADMIN` in Prisma and `UserRole = 'ADMIN'` in `src/interface/index.ts`). Regular users/students do not have user accounts.
- DB-row expiry for refresh tokens is hardcoded to 7 days in `auth.service.ts`, independent of `JWT_REFRESH_EXPIRES_IN`.

### Discord bot & member sync

Runs **in the same process as Express**, under `src/lib/discord/` (not a module, because the gateway event handlers are not HTTP-scoped):

- `client.ts` — the single shared `Client` (`Guilds` + `GuildMembers` intents), `startDiscordBot()` / `stopDiscordBot()`, and all `Events.*` registrations. **Never throws**: a bad token, a missing config value, or an unreachable guild is logged and the REST API keeps serving.
- `member.sync.ts` — full `guild.members.fetch()` sync, chunked 200-per-`$transaction`, plus the module-level sync state that `/api/discord/sync/status` reports.
- `member.mapper.ts`, `events/*.ts` — `GuildMember` → DB payload, and the four live listeners (`guildMemberAdd`, `guildMemberRemove`, `guildMemberUpdate`, `userUpdate`).

Rules that matter:

- **`DiscordMember` ≠ `User`.** `discord_members` is the synced guild directory and never authenticates; `users` is the ADMIN login account. Attendance/daily-update FKs belong on `DiscordMember`.
- **Upsert on `discordUserId`, never on `discordUsername`.** Discord handles are mutable, so upserting on username creates a duplicate row on every rename. `upsertMemberPayload()` also handles the P2002 case where a member renames onto a handle another row still holds.
- **Departure flags, never deletes** — `isInGuild: false` + `leftAt`, so attendance history keeps a valid owner. Query `where: { isInGuild: true }` when you mean "currently in the server".
- **The departure guard**: if a member fetch returns 0 non-bots, or under 50% of the stored active count, the reconcile is skipped and logged loudly. Never remove it — without it a truncated fetch marks the whole directory departed in one `updateMany`, locking every student out of the attendance form.
- **Server Members privileged intent** must be ON in the Discord Developer Portal. With it off, Discord rejects the connection outright (`Used disallowed intents`) rather than returning a partial list, so the bot fails to log in and sync never runs — the API keeps serving either way.
- Channel and guild IDs always come from `.env` (`src/config/discord.ts`, Zod-validated as 17–20 digit snowflakes). Never key logic off a channel name.

### Error handling

`src/errors/globalErrorHandler.ts` is the single response formatter. It branches on `ZodError` → `AppError` → `Prisma.PrismaClientValidationError` → known request codes (P2002 duplicate, P2023 cast, P2025 not-found, P2003 FK) → unknown/init errors → generic fallback, delegating shape to the small handlers in `src/errors/*Error.ts`. Stacks are only included when `NODE_ENV=development`.

Because P2025 is handled centrally, services use `findUniqueOrThrow` rather than manual not-found checks.

## Caveats

- Auth cookies are set with `secure: false, sameSite: 'none'`, which browsers reject — dev-only settings that need fixing before deployment.
- `postman-collection.json` documents the API with `baseUrl` configured to `http://localhost:8000/api`.
- **`DISCORD_USERNAME_REGEX` must never be tightened to forbid a leading or trailing `_` / `.`.** The PID originally specified `/^(?![_.@])(?!.*\.{2})[a-z0-9_.]{2,32}(?<![_.])$/`, which rejected 115 of 2189 live members (5.3%) — `itzazad_`, `.rabbil`, `shahriarratul.`. Snowflake timestamps proved 59 of those accounts postdate Discord's Pomelo rollout, so the handles are current and valid, not grandfathered. The regex is now `/^(?!.*\.{2})[a-z0-9_.]{2,32}$/` and is verified against every synced member. Re-run that check after any change to it: tightening it locks real students out of the attendance form, violating Golden Rule 3.
