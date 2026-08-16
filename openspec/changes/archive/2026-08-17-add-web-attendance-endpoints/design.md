## Context

Phase 2 finished the attendance persistence layer: `attendances` exists with `@@unique([memberId, attendanceDate])`, `src/repositories/attendance.repository.ts` can create and look up rows, and `src/utils/dhakaDate.ts` is the sole producer of `YYYY-MM-DD` civil dates. Phase 1 finished the directory: `discord_members` is kept in sync by the gateway listeners, departures are flagged with `isInGuild: false` rather than deleted, and `src/utils/discordUsername.ts` holds the normalization and the official-standard regex.

What is missing is the seam between them and the outside world. Every route currently registered — `/api/auth`, `/api/users`, `/api/discord` — sits behind `auth(UserRole.ADMIN)`. The attendance form has no account and cannot get one: students are not `User` rows by design. So these two endpoints are the first in the codebase where an unauthenticated caller reaches a Prisma write, and the design has to compensate for the missing `auth()` middleware rather than simply omit it.

Three constraints shape everything below:

- **Golden Rule 3** — a handle absent from the server member list must never be able to submit. This is an enforcement requirement, not a UI requirement, so it lives on the write path.
- **Golden Rule 7** — duplicate prevention is the database constraint, never a read-then-write check.
- **CLAUDE.md's layering** — controllers never touch Prisma, services own business rules and throw `AppError`, repositories own Prisma and nothing else.

There is a second wrinkle: `member.sync.ts` renames a stale departed member's handle to `<handle>#departed-<discordUserId>` when a live member reclaims that username. Those rows are unreachable by an exact-match lookup on the clean handle, which is exactly the intent — but it means "not found" and "found but departed" are both real outcomes and the lookup must not assume the first implies the second.

## Goals / Non-Goals

**Goals:**

- Two public endpoints that let the attendance form verify a handle live and record a day's submission.
- Verification enforced on the write path, independently of whatever the read path returned.
- Duplicate submissions refused with a message naming the Dhaka date, driven by the uniqueness constraint rather than a pre-check.
- A per-IP request budget on both endpoints, isolated behind one module so the store can move to Redis in Phase 6 without touching routes.
- No new drift: the directory lookup becomes one shared repository function, not a Prisma call inlined in a service.

**Non-Goals:**

- The Next.js attendance form. This repository is backend-only; the UI is a separate change against a separate codebase. What ships here is the contract it will call.
- Any authentication or identity for students. The membership check *is* the authorization model for these endpoints.
- CAPTCHA, proof-of-work, or bot detection. Rate limiting plus the membership requirement is the protection this phase buys.
- A distributed rate-limit store. In-memory now; the abstraction point is what this change guarantees.
- Editing or deleting an existing submission. There is no correction path in this phase.
- Any change to the schema, the migration set, or the daily-status aggregation.

## Decisions

### The module is `src/modules/attendance/`, and the directory lookup is a repository

The four-file module shape applies unchanged: `attendance.routes.ts`, `attendance.validation.ts`, `attendance.controller.ts`, `attendance.service.ts`, exporting `attendanceRouter` / `attendanceValidation` / `attendanceController` / `attendanceService`, registered in `src/app.ts` at `/api/attendance`.

The member lookup, however, goes into a new `src/repositories/member.repository.ts` rather than into `attendance.service.ts`, even though this change has only one caller. Phase 4's `messageCreate` handler must resolve `message.author.id` to a member row from inside a gateway listener, and Phase 6's worker must resolve members for DM targeting. Those are not HTTP-scoped and must not reach into a module service — the same reasoning that produced `src/repositories/` in Phase 2. Putting it there now costs one file and avoids a Prisma call being copied out of a service later.

The function is `findActiveMemberByUsername(normalizedUsername)`, filtering on `isInGuild: true` and returning `null` otherwise. The `isInGuild` filter belongs in the query, not in the service: `discord_members` has an `@@index([isInGuild])` and every other consumer of the directory already filters this way. It returns `null` for both "no row" and "departed row" — the service does not need to tell them apart, because the response is the same either way, and distinguishing them would leak that a specific person used to be in the server.

*Alternative considered:* `discordService` already owns Prisma directly for the directory. Adding the lookup there would keep member concerns in one place. Rejected because `discordService` is HTTP-scoped admin tooling (sync status, trigger sync) and the gateway listeners cannot call it.

### Verification is advisory; submission is authoritative

`GET /api/attendance/verify-user` exists to let the form render a ✅ badge and enable its submit button. It is a convenience. `POST /api/attendance/submit` re-normalizes, re-validates the format, and re-looks-up membership before writing anything.

This is not redundancy for its own sake. The two calls are separated by however long the student takes to finish the form, and `guildMemberRemove` fires in between often enough to matter in a 5,000-member server. More importantly, the verify endpoint is public and nothing forces a client to call it — a direct `POST` is trivially constructed. Treating the read path as a gate would put Golden Rule 3's enforcement in the browser.

The two paths share one internal service helper that normalizes, format-checks, and resolves the member, so the two definitions of "verified" cannot drift.

### Both endpoints resolve "today" through `getDhakaDate()`, once per request

Each request calls `getDhakaDate()` a single time and threads the result through — the already-submitted lookup, the attendance insert, and the message text all use the same string. Calling it twice within one request is a real bug at 23:59:59.9, where the second call can land on the next day and produce a response claiming a date the row does not carry.

### The duplicate is caught in the service and re-thrown with the date

CLAUDE.md establishes that P2002 is handled centrally, and it stays that way as the fallback. But §3.4 of the PID requires the refusal to name the date the student already submitted for, and the central handler has no way to know which date that was or which of a model's unique constraints fired.

So `attendance.service.ts` wraps the write, inspects a `PrismaClientKnownRequestError` with code `P2002` whose target is the `(member_id, attendance_date)` constraint, and throws `AppError(409, ...)` naming the date. Any other P2002 is re-thrown untouched and reaches the central handler as before.

This preserves Golden Rule 7 exactly: there is still no read-then-write check. The constraint is what decides; the service only translates its outcome. Two simultaneous submissions still resolve to one row, and the loser gets the same 409 as a sequential retry.

*Alternative considered:* look up the existing row first and return early. Rejected — it does not survive concurrency, which is the entire reason the constraint exists.

Note that `alreadySubmitted` on the *verify* endpoint is a genuine read (`findAttendanceByMemberAndDate`) and that is fine: it is reporting state to the UI, not gating a write.

### Contact details and the attendance row are written in one transaction

PID §8.2 step 2 requires the submitted phone and email to be saved onto the member. That is a second write, and it must not survive a failed first one — a member whose contact details were updated but whose attendance was rejected as a duplicate would be a silent inconsistency the dashboard would later act on.

Both writes go into one `$transaction`, with the attendance insert first so a P2002 aborts before the directory entry is touched. The transaction lives in the repository layer (a `createAttendanceWithMemberContact` on `attendance.repository.ts`, or an equivalent), because the repository owns Prisma; the service decides that the two writes belong together.

The denormalized `name` / `email` / `phone` on the attendance row remain the values submitted that day, per the Phase 2 schema comment — updating the directory does not rewrite history.

### `validateQuery` is added rather than bending `validateRequest`

`validateRequest` parses `req.body`, and `verify-user` carries its input in the query string. Rather than overload it with a target parameter, a sibling `validateQuery(schema)` is exported from the same file.

Under Express 5, `req.query` is a getter — the parsed result cannot be assigned back onto the request. So `validateQuery` validates and calls `next()` without mutating anything; the controller reads `req.query.username` as the raw string and hands it to the service, which normalizes. The schema's job is to reject the malformed request before any work happens, not to supply a transformed value.

*Alternative considered:* skip the middleware and validate inside the controller. Rejected — it would put a validation concern in the layer that is supposed to have none, and the route file would no longer document what the endpoint accepts.

### Format validation and lookup failure are separate outcomes

A malformed handle is a `400` from the Zod layer (`DISCORD_USERNAME_REGEX` as a `refine`), never reaching the database. A well-formed handle with no active member is a `200` from `verify-user` with `verified: false`, and a `404` from `submit`.

The verify endpoint deliberately returns `200` for an unknown handle rather than `404`: not-found is the expected, routine answer there, and the form needs to render a message either way. The submit endpoint uses `404` because it is a genuine failure to act.

### Response bodies live inside the `sendResponse` envelope

The PID sketches `verified` and `alreadySubmitted` as top-level response keys. `sendResponse` emits a fixed `{ success, statusCode, message, meta, data }` shape and every existing endpoint uses it, so those flags go inside `data`. The form reads `data.verified`, not `verified`. Changing the envelope for two endpoints would be worse than the small divergence from the PID's sketch.

```
GET /api/attendance/verify-user?username=rakib_dev
200 { success: true, statusCode: 200, message: "...", data: {
       verified: true, alreadySubmitted: false, attendanceDate: "2026-08-17",
       member: { id, discordUsername, displayName, avatarUrl } } }

200 { ..., data: { verified: false, alreadySubmitted: false, attendanceDate: "2026-08-17", member: null } }
```

`member` is `null` whenever `verified` is false — no partial disclosure about handles that are not active members.

### Rate limiting: `express-rate-limit`, two limiters, one module

`src/middlewares/rateLimit.ts` exports a limiter per endpoint, built with `express-rate-limit`'s current options — `windowMs`, `limit`, `standardHeaders: true`, `legacyHeaders: false` — and a `handler` that routes the refusal through `sendResponse` so a `429` looks like every other response the API produces.

Two distinct budgets, because the workloads are nothing alike. `verify-user` fires on a 500 ms debounce as a student types, so a single honest form session produces perhaps a dozen calls; its window is generous. `submit` is once per day per student; its budget is small enough that a scripted flood is stopped after a handful of attempts. The exact numbers are an implementation detail to tune, but the *ratio* is the requirement — submit is materially tighter.

Proxy handling matters here. `express-rate-limit` raises `ERR_ERL_PERMISSIVE_TRUST_PROXY` when Express is configured with `trust proxy: true`, because the leftmost `X-Forwarded-For` entry is then attacker-controlled and every budget becomes bypassable with a forged header. So `app.set('trust proxy', <hop count>)` is set to a specific number of hops, or left unset, and never to `true`.

The store stays the library default (in-memory) for now. It is process-local, so N processes multiply the effective budget by N — acceptable at this stage and recorded as a known trade-off. Phase 6 introduces Redis for BullMQ; swapping in `rate-limit-redis` at that point touches only this file.

*Alternatives considered:* a hand-rolled `Map`-keyed limiter, avoiding the dependency — rejected because getting window rollover, IPv6 subnet grouping, and header semantics right is exactly the work this well-maintained package has already done. Deferring rate limiting entirely — rejected because a public `POST` that writes rows is the wrong thing to leave unprotected while waiting for a hardening phase.

### CORS becomes an origin allowlist

`src/app.ts` currently sets `origin: process.env.APP_URL` with `credentials: true` — one origin, the admin dashboard. The attendance form is a different deployment on a different host, and a browser will block its `fetch` outright.

The origin becomes an array built from `APP_URL` plus a new attendance-form URL entry, validated in `src/config/`. It stays an explicit allowlist; `origin: true` or `'*'` is not an option while `credentials: true` is set.

## Risks / Trade-offs

- **In-memory rate-limit counters are per-process** → Accepted for this phase and specified openly. Single-process deployment today; the store is behind one module and Phase 6's Redis is the migration.

- **A misconfigured `trust proxy` makes every budget bypassable** → Never set `trust proxy` to `true`. Use a hop count, and leave the library's `ERR_ERL_PERMISSIVE_TRUST_PROXY` validation enabled so a bad configuration is loud at boot rather than silent in production.

- **The form is only as good as the directory sync** → If `member.sync.ts`'s under-50% departure guard were removed and a truncated fetch flagged the directory departed, `findActiveMemberByUsername` would return `null` for everyone and no student could submit. This change makes that guard load-bearing for the student-facing path, not just the dashboard. Do not remove it. The `verify-user` endpoint is also the fastest way to notice such a failure — a sudden collapse in verification success rate is the symptom.

- **A username rename between verification and submission** → `userUpdate` rewrites `discordUsername` live. A student who renames mid-form submits under a handle that no longer resolves and gets a not-found. Rare, self-correcting on retry with the new handle, and preferable to matching on a stale handle. Not worth a fallback lookup by `discordUserId`, which the form does not have.

- **Rate limiting is per-IP, and students may share one** → A university lab or a mobile carrier NAT can put many students behind one address. This is why the verify budget is generous and the ratio, not the absolute number, is the specified requirement. If shared-IP throttling shows up in practice, the fix is raising the window, not removing the limiter.

- **Two endpoints, no automated tests** → No test framework is configured in this repository, so verification is manual through the Postman collection. The scenarios in the delta specs are written to be executable by hand, and the concurrency scenario (two simultaneous submissions resolving to one row) is the one that most deserves a deliberate manual check.

- **Public endpoints accept unvalidated free text into `name`** → Stored as submitted, per the Phase 2 schema decision, and rendered later by the dashboard and by CSV export. The Zod rule restricts `name` to letters and spaces, which removes the obvious injection surface; CSV formula injection on export remains a Phase 7 concern, not this change's.

## Migration Plan

Additive only — no schema change, no migration, no behavior change to any existing route.

1. `bun install` for `express-rate-limit`.
2. Add the attendance form's origin to `.env` and `.env.example`; existing deployments keep working on `APP_URL` alone until the form ships.
3. Deploy. The new routes are inert until something calls them.

Rollback is removing the route registration from `src/app.ts`; nothing else depends on these endpoints, and no data written by them is read by anything shipped so far.

## Open Questions

- **Exact rate-limit numbers.** The ratio is specified; the absolute budgets should be set from the form's real debounce interval and revisited after the first week of live traffic.
- **`AttendanceStatus` beyond `PRESENT`.** The enum carries `LATE` and `EXCUSED`, but nothing in Phase 3 sets them — every web submission is `PRESENT`. Whether "late" should be derived from submission time against a cutoff is a product question for a later phase.
- **Whether a confirmation should be sent to Discord.** PID §8.2 step 4 mentions logging to Discord or returning a confirmation. This change returns the confirmation in the HTTP response only; a bot-side log message is deferred.
