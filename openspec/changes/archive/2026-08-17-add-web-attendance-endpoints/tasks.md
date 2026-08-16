## 1. Dependencies & Configuration

- [x] 1.1 Add `express-rate-limit` with `bun add express-rate-limit`; confirm it lands in `dependencies`, not `devDependencies`
- [x] 1.2 Add the attendance form's public origin as a new environment entry in `.env` and `.env.example`, validated in `src/config/` alongside the existing values
- [x] 1.3 Change the CORS `origin` in `src/app.ts` from the single `APP_URL` to an allowlist array built from `APP_URL` plus the form origin, keeping `credentials: true` and never using `'*'` or `origin: true`
- [x] 1.4 Set `app.set('trust proxy', <hop count>)` in `src/app.ts` as a number of hops or leave it unset — never `true`, which makes every rate-limit budget bypassable with a forged `X-Forwarded-For`

## 2. Rate Limiting Middleware

- [x] 2.1 Create `src/middlewares/rateLimit.ts` exporting one limiter per public endpoint, built with `rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false })`
- [x] 2.2 Give the verify limiter a window sized for a 500 ms-debounced typing session and the submit limiter a materially tighter budget; document both numbers with a comment saying what workload they assume
- [x] 2.3 Supply a `handler` that emits the refusal through `sendResponse` with a `429` and a wait-and-retry message, so a throttled response has the same envelope as every other endpoint
- [x] 2.4 Keep the counting store as the library default (in-memory) and note in a comment that it is process-local and that Phase 6's Redis swaps in here and nowhere else
- [x] 2.5 Leave the library's `trustProxy` validation enabled so a misconfiguration surfaces as `ERR_ERL_PERMISSIVE_TRUST_PROXY` at boot

## 3. Query Validation Middleware

- [x] 3.1 Add a `validateQuery(schema)` export beside `validateRequest` in `src/middlewares/validateRequest.ts`, parsing `req.query` and calling `next()` without assigning back — `req.query` is a getter under Express 5
- [x] 3.2 Verify a malformed query string produces the standard `ZodError` response shape through `globalErrorHandler`

## 4. Member Repository

- [x] 4.1 Create `src/repositories/member.repository.ts` exporting `memberRepository` with `findActiveMemberByUsername(normalizedUsername)`
- [x] 4.2 Filter the query on `isInGuild: true` and return `null` for both an absent row and a departed one — the service must not be able to tell them apart
- [x] 4.3 Select only the fields the form needs (`id`, `discordUserId`, `discordUsername`, `displayName`, `avatarUrl`) rather than the whole row
- [x] 4.4 Keep the file free of `AppError`, HTTP status codes, and `req`, per the repository rule in CLAUDE.md; add the file-level comment explaining why the lookup lives here (Phase 4 ingestion and Phase 6 DM targeting are non-HTTP callers)

## 5. Transactional Attendance Write

- [x] 5.1 Add a repository function to `src/repositories/attendance.repository.ts` that creates the attendance row and updates the member's `email` / `phone` inside one `$transaction`
- [x] 5.2 Order the transaction with the attendance insert first, so a P2002 aborts before the directory entry is touched
- [x] 5.3 Let P2002 propagate out of the repository unchanged — translating it is the service's job
- [x] 5.4 Leave the existing `createAttendance` in place if any caller still needs the plain insert; otherwise fold it into the transactional version rather than keeping two ways to write the same row

## 6. Attendance Module — Validation

- [x] 6.1 Create `src/modules/attendance/attendance.validation.ts` exporting `attendanceValidation`
- [x] 6.2 Add the verify-user query schema: a required `username` string refined with `isValidDiscordUsername` from `@/utils/discordUsername`
- [x] 6.3 Add the submit body schema with exactly four fields — `name` (min 3, letters and spaces only), `phone` (accepting `01XXXXXXXXX` and `+8801XXXXXXXXX`), `email`, and `discordUsername` (same refine as 6.2)
- [x] 6.4 Reuse `DISCORD_USERNAME_REGEX` from `@/utils/discordUsername` — never re-declare or tighten it here; a leading or trailing `_` / `.` must stay valid
- [x] 6.5 Give every rule an explicit `error` message naming what the student should fix, matching the existing Zod style in `auth.validation.ts`

## 7. Attendance Module — Service

- [x] 7.1 Create `src/modules/attendance/attendance.service.ts` exporting `attendanceService`
- [x] 7.2 Write one internal helper that normalizes a raw handle with `normalizeDiscordUsername`, format-checks it, and resolves it through `memberRepository.findActiveMemberByUsername` — both endpoints call it so the two definitions of "verified" cannot drift
- [x] 7.3 Implement `verifyUser(rawUsername)`: resolve today's date once with `getDhakaDate()`, return `verified: false` with `member: null` when the helper yields nothing, otherwise call `findAttendanceByMemberAndDate` and return `verified`, `alreadySubmitted`, `attendanceDate`, and the member details
- [x] 7.4 Implement `submitAttendance(payload)`: re-normalize, re-verify membership server-side, and throw `AppError(404, ...)` when the member is absent or departed — never trust that the client called verify first
- [x] 7.5 Resolve `getDhakaDate()` exactly once per request and thread the value through the lookup, the insert, and the message text; calling it twice can straddle midnight and report a date the row does not carry
- [x] 7.6 Wrap the transactional write and catch `PrismaClientKnownRequestError` with code `P2002` on the `(member_id, attendance_date)` constraint, re-throwing as `AppError(409, ...)` with the Dhaka date named in the message; re-throw any other P2002 untouched so the central handler still shapes it
- [x] 7.7 Add no read-then-write existence check before the insert — the unique constraint is the enforcement point (Golden Rule 7)

## 8. Attendance Module — Controller & Routes

- [x] 8.1 Create `src/modules/attendance/attendance.controller.ts` with both handlers wrapped in `catchAsync`, returning through `sendResponse` and touching no Prisma
- [x] 8.2 Return `200` from verify-user for an unknown handle (not-found is the routine answer the form must render) and place `verified` / `alreadySubmitted` inside `data`, per the envelope decision in design.md
- [x] 8.3 Return `201` from submit on success with the recorded date in the response
- [x] 8.4 Create `src/modules/attendance/attendance.routes.ts` exporting `attendanceRouter`, wiring `GET /verify-user` with its limiter and `validateQuery`, and `POST /submit` with its limiter and `validateRequest`
- [x] 8.5 Apply no `auth()` middleware to either route, and add a comment on the router saying these are the only public routes in the application and why
- [x] 8.6 Register `attendanceRouter` at `/api/attendance` in `src/app.ts`

## 9. Verification

- [x] 9.1 `bun run lint` and `bun run build` both clean
- [x] 9.2 Verify a handle held by a current member — `verified: true` with display name and avatar returned
- [x] 9.3 Verify a handle held by a member flagged `isInGuild: false` — `verified: false`, `member: null`, and the departed row untouched
- [x] 9.4 Verify handles with a leading and trailing separator (`itzazad_`, `.rabbil`, `shahriarratul.`) against live synced data — all must pass format validation and resolve
- [x] 9.5 Verify `@Rakib_Dev` with surrounding whitespace resolves to the same member as `rakib_dev`
- [x] 9.6 Verify malformed handles (`rakib..dev`, one character, containing a space, carrying `#0001`) each return a `400` format error with no directory lookup
- [x] 9.7 Submit a valid attendance and confirm one row exists with the submitted name, phone, and email, and today's Dhaka date
- [x] 9.8 Confirm the same submission updated the member's `email` and `phone` on `discord_members`
- [x] 9.9 Submit again as the same member and confirm a `409` naming today's date, with the original row unchanged
- [x] 9.10 Fire two identical submissions concurrently and confirm exactly one row exists and the loser received the `409`, not an unknown error
- [x] 9.11 Submit for a handle with no directory row and confirm `404` with nothing written
- [x] 9.12 Exhaust the verify budget from one client and confirm a `429` in the standard envelope, that the submit budget is unaffected, and that a different client is served normally
- [x] 9.13 Confirm `TZ=UTC bun run start:dev` records a submission against the Dhaka date, not the UTC one
- [x] 9.14 Confirm a browser request from the form's origin passes CORS and one from an unlisted origin does not

## 10. Documentation

- [x] 10.1 Add both endpoints to `postman-collection.json` with example requests and each documented failure response, since the form is built against this contract in a separate repository
- [x] 10.2 Update CLAUDE.md: the attendance module exists, `/api/attendance` is registered and is the only unauthenticated surface, `src/repositories/member.repository.ts` is added, `validateQuery` now sits beside `validateRequest`, and rate limiting lives in `src/middlewares/rateLimit.ts`
- [x] 10.3 Note in CLAUDE.md that the departure guard in `member.sync.ts` is now load-bearing for the student-facing form, not only the dashboard
- [x] 10.4 Tick Phase 3's first two roadmap lines in `PRD.md`, leaving the Next.js form line unticked — it belongs to a separate repository
