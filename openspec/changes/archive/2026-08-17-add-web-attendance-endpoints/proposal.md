## Why

Phase 2 landed the attendance tables, the `(member_id, attendance_date)` uniqueness constraint, and `src/repositories/` — but nothing can write to them. There is no HTTP surface for a student to submit attendance, and no way for the form to ask "is this handle actually in our server?" before enabling its submit button. The persistence layer is finished and idle.

This change lands Phase 3 of the roadmap: the two public endpoints the attendance form calls. `GET /api/attendance/verify-user` answers the live membership check that Golden Rule 3 requires, and `POST /api/attendance/submit` writes the day's record. Together they are the first path in the system that accepts input from an unauthenticated stranger on the internet, which is why per-IP rate limiting ships in the same change rather than after it.

## What Changes

- Add `src/modules/attendance/` following the established four-file module shape (`routes`, `validation`, `controller`, `service`), registered in `src/app.ts` under `/api/attendance`.
- Add `GET /api/attendance/verify-user?username=<handle>` — **public, no `auth()` middleware**. Normalizes and format-validates the handle, looks it up in the synced directory, and reports `verified`, `alreadySubmitted`, and the member's display name and avatar so the form can render a ✅ badge.
- Add `POST /api/attendance/submit` — **public**. Zod-validates full name, phone, email, and Discord username; re-verifies guild membership server-side; saves the declared contact details onto the member row; and inserts the attendance record for today's Dhaka date.
- Re-verify membership inside `submit` rather than trusting that the client called `verify-user` first. The verify endpoint is a UI affordance; the submit endpoint is the enforcement point. A member who left the guild between the two calls is rejected.
- Treat `isInGuild: false` as not verified. A departed member's row still exists — it is retained so their history keeps an owner — but they cannot submit new attendance.
- Add `src/repositories/member.repository.ts` with `findActiveMemberByUsername`, so the directory lookup is one shared definition rather than a Prisma call inside a module service. Phase 4's `messageCreate` ingestion needs the same lookup from a non-HTTP caller.
- Handle the duplicate submission as a domain outcome, not a generic database error: the service catches Prisma P2002 on the attendance uniqueness constraint and raises a `409` carrying the Dhaka date the student already submitted for, as the PID's §3.4 message requires.
- Add per-IP rate limiting via `express-rate-limit`, applied as `src/middlewares/rateLimit.ts`. `verify-user` gets a budget sized for a debounced-keystroke workload; `submit` gets a far tighter one. In-memory store now, with the store isolated behind one module so Phase 6's Redis can be swapped in without touching the routes.
- Add a `validateQuery` sibling to `validateRequest`, because `verify-user` carries its input in the query string and the existing middleware validates `req.body` only.
- Widen the CORS origin from the single `APP_URL` to an allowlist, so the public attendance form and the admin dashboard can be served from different origins.
- Add both endpoints to `postman-collection.json`.

## Capabilities

### New Capabilities

- `web-attendance-submission`: The public HTTP surface a student uses to record attendance — how a Discord handle is normalized and verified against the live guild directory, what "already submitted" means and when it is reported, which submissions are rejected and why, and the guarantee that the submit endpoint enforces every rule independently of what the verify endpoint said.
- `public-endpoint-rate-limiting`: Abuse protection for endpoints reachable without an admin token — how request budgets are scoped and counted, what a throttled caller receives, and the rule that a legitimate student filling the form once a day is never throttled.

### Modified Capabilities

None. `attendance-data-model` already specifies the one-per-member-per-day constraint and the retention rules this change relies on; `dhaka-calendar-date` already specifies how today is derived; `discord-member-sync` already specifies that departed members are flagged rather than deleted. This change consumes all three unchanged.

## Impact

- **API**: two new public routes under `/api/attendance`. These are the first endpoints in the codebase that are not behind `auth()`. Every other route requires an `ADMIN` token; the attendance form has no account to authenticate with, so the membership check and the rate limiter are what stand in for authorization.
- **Code**: new `src/modules/attendance/`, new `src/repositories/member.repository.ts`, new `src/middlewares/rateLimit.ts`, a new `validateQuery` export in `src/middlewares/validateRequest.ts`, and route registration plus a CORS change in `src/app.ts`.
- **Dependencies**: adds `express-rate-limit`. No other additions — validation is Zod, already present.
- **Schema**: none. No migration. Phase 2's tables are used exactly as they stand.
- **Response envelope**: the PID sketches `verified` and `alreadySubmitted` as top-level response keys. This repo's `sendResponse` has a fixed envelope, so they are carried inside `data`. The form reads `data.verified`, not `verified`.
- **Configuration**: CORS origin becomes a list. The form's public URL needs an environment entry alongside `APP_URL`.
- **Depends on the departure guard**: `verify-user` returns "not found" for any member whose `isInGuild` is false. If `member.sync.ts`'s under-50% guard were ever removed and a truncated fetch mass-flagged the directory, every student would be locked out of the form at once. This change makes that guard directly load-bearing for the student-facing path, not only for the dashboard.
- **Not in scope**: the Next.js attendance form itself — this repository holds only the backend, and the UI is a separate change. Also out of scope: the `messageCreate` daily-update listener (Phase 4), the channel open/lock scheduler (Phase 5), the BullMQ reminder queue (Phase 6), and the admin dashboard endpoints (Phase 7).
