# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Express 5 + TypeScript + Prisma 7 (PostgreSQL) REST API for a Discord daily-attendance / update automation admin dashboard. Currently only auth and user modules exist; the attendance domain is not built yet.

## Commands

Bun is the package manager (`bun.lock`); the scripts themselves still run through Node/tsx.

```bash
bun install
bun run start:dev      # tsx watch src/server.ts (dev server)
bun run build          # tsc && tsc-alias -f  (tsc-alias rewrites @/* paths in dist)
bun run start          # node ./dist/src/server.js
bun run lint           # eslint src
bun run lint:fix
bun run format         # see caveat below
bun run format:check

docker compose up -d   # PostgreSQL 16, reads POSTGRES_* from .env, host port 5433 by default

bunx prisma generate   # REQUIRED after clone and after any schema change
bunx prisma migrate dev --name <name>
bunx prisma studio
```

No test framework is configured.

## Prisma setup (the main source of surprises)

- **Config lives in `prisma.config.ts`**, not `package.json`. It points at the *directory* `prisma/schema/` (split schema: `schema.prisma` holds generator + datasource, `auth.prisma` holds `User`/`RefreshToken`, `user.prisma` holds `Profile`). Adding a new `.prisma` file to that directory is enough for it to be picked up.
- The `prisma-client` generator outputs to **`generated/prisma`**, which is **gitignored**. A fresh clone will not typecheck until `bunx prisma generate` runs.
- Import generated types from the `@generated/*` alias (`@generated/prisma/client`, `@generated/prisma/enums`) — never from `@prisma/client`.
- The datasource block has **no `url`**; the connection is supplied at runtime by the `@prisma/adapter-pg` driver adapter in `src/lib/prisma.ts` (and by `prisma.config.ts` for CLI commands). Always use the shared `prisma` singleton from `@/lib/prisma`.

## Architecture

ESM (`"type": "module"`) with path aliases `@/*` → `src/*` and `@generated/*` → `generated/*`.

`src/server.ts` connects Prisma then listens; `src/app.ts` wires CORS (credentials, origin `APP_URL`), JSON/urlencoded/cookie parsers, routers under `/api/auth` and `/api/users`, then `notFoundRoute` and `globalErrorHandler` last.

### Module pattern

Each feature under `src/modules/<name>/` is four files with fixed roles, each exporting a single named object (`authService`, `userController`, …):

- `*.routes.ts` — composes `validateRequest(schema)` and `auth(...roles)` middleware, exports `<name>Router`.
- `*.validation.ts` — Zod v4 schemas validating **`req.body` only**.
- `*.controller.ts` — wrapped in `catchAsync`, reads `req.user`, returns via `sendResponse(res, { success, statusCode, message, data, meta? })`. All responses go through `sendResponse`; controllers never touch Prisma.
- `*.service.ts` — all Prisma access and business rules; throws `AppError(statusCode, message)`.

New modules follow this shape and are registered in `src/app.ts`.

### Auth flow

- Login issues an access + refresh JWT, **persists the refresh token row in `refresh_tokens`**, and sets both as httpOnly cookies *and* returns them in the body.
- `/api/auth/refresh-token` reads the refresh token from the cookie, checks the DB row and expiry, then **rotates** it (delete + create in one `$transaction`). Logout deletes the row.
- `src/middlewares/auth.ts` reads the **raw `Authorization` header with no `Bearer ` prefix** — clients send the bare token. It verifies the access JWT, reloads the user, rejects non-`ACTIVE` status, enforces `requiredRoles`, bumps `lastActiveAt`, and populates `req.user` (typed via the global Express `Request` augmentation declared in that file).
- Roles are duplicated in two places: the Prisma `UserRole` enum and the string-union `UserRole` in `src/interface/index.ts`. Keep them in sync.
- DB-row expiry for refresh tokens is hardcoded to 7 days in `auth.service.ts`, independent of `JWT_REFRESH_EXPIRES_IN`.

### Error handling

`src/errors/globalErrorHandler.ts` is the single response formatter. It branches on `ZodError` → `AppError` → `Prisma.PrismaClientValidationError` → known request codes (P2002 duplicate, P2023 cast, P2025 not-found, P2003 FK) → unknown/init errors → generic fallback, delegating shape to the small handlers in `src/errors/*Error.ts`. Stacks are only included when `NODE_ENV=development`.

Because P2025 is handled centrally, services use `findUniqueOrThrow` rather than manual not-found checks.

## Caveats

- `.prettierrc` sets `"semi": false`, but the entire committed codebase is written **with** semicolons. Running `bun run format` reformats every file. Don't run it repo-wide unless that reformat is the intent.
- Auth cookies are set with `secure: false, sameSite: 'none'`, which browsers reject — dev-only settings that need fixing before deployment.
- `postman-collection.json` documents the API but its `baseUrl` is `http://localhost:5000/api` while `.env.example` sets `PORT=8000`.
