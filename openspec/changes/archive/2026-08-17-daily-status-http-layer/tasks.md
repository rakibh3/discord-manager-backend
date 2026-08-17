## 1. Repository: single-member query

- [x] 1.1 Add `getDailyStatusForMember(memberId, date)` to `src/repositories/dailyStatus.repository.ts` — returns the member's status row (same SELECT/CASE as the page query) plus `null` when the member doesn't exist
- [x] 1.2 Export the new function from `dailyStatusRepository`

## 2. Validation

- [x] 2.1 Create `src/modules/dailyStatus/dailyStatus.validation.ts` with Zod schemas for all four endpoints:
  - `countsQuerySchema`: `{ date }` — required, `dhakaDateSchema`
  - `pageQuerySchema`: `{ date, page?, limit?, status?, search? }` — date required, page/limit coerced integers, status enum, search string
  - `memberQuerySchema`: `{ date }` — required
  - `exportQuerySchema`: `{ date, status?, search?, format }` — format enum `csv | xlsx`

## 3. Service

- [x] 3.1 Create `src/modules/dailyStatus/dailyStatus.service.ts` with four functions:
  - `getCounts(date)` — calls `getDailyStatusCounts`, renames `bothCompleted → bothComplete`, echoes date back
  - `getPage(query)` — calls `getDailyStatusPage`, renames `submittedAt → attendanceSubmittedAt` on each row
  - `getMemberStatus(memberId, date)` — calls `getDailyStatusForMember`, maps messages from `dailyUpdateRepository.listUpdatesByMemberAndDate` (`id → id`, `message → content`, `messageCreatedAt → postedAt`), throws 404 if member not found
  - `exportPage(query)` — streams all matching rows via paginated calls to `getDailyStatusPage`, applies formula-injection prevention, yields CSV rows

## 4. Controller

- [x] 4.1 Create `src/modules/dailyStatus/dailyStatus.controller.ts` with four handlers:
  - `getCounts` — passthrough to service, `sendResponse` with 200
  - `getPage` — reads paging from query, calls service, `sendResponse` with `meta`
  - `getMemberStatus` — reads `memberId` from params and `date` from query, calls service, `sendResponse`
  - `exportData` — reads query params, pipes CSV/XLSX stream to response with correct `Content-Type` and `Content-Disposition` headers (no `sendResponse` — raw stream)

## 5. Routes

- [x] 5.1 Create `src/modules/dailyStatus/dailyStatus.routes.ts`:
  - `GET /counts` → `auth(ADMIN)`, `validateQuery(countsQuerySchema)`, `controller.getCounts`
  - `GET /export` → `auth(ADMIN)`, `validateQuery(exportQuerySchema)`, `controller.exportData`
  - `GET /members/:memberId` → `auth(ADMIN)`, `validateQuery(memberQuerySchema)`, `controller.getMemberStatus`
  - `GET /` → `auth(ADMIN)`, `validateQuery(pageQuerySchema)`, `controller.getPage`
  - Route order: `/counts`, `/export`, `/members/:memberId` before `/` to prevent Express matching them as query params

## 6. App registration

- [x] 6.1 Import `dailyStatusRouter` in `src/app.ts` and add `app.use('/api/daily-status', dailyStatusRouter)` alongside the existing routes

## 7. Attendance validation fix

- [x] 7.1 In `src/modules/attendance/attendance.validation.ts`, replace `.regex(/^[\p{L}\s]+$/u, …)` with `.regex(/^[A-Za-z\s]+$/, { error: 'Full name must use English letters and spaces only' })`

## 8. Dead .env line

- [x] 8.1 Remove the `DAILY_STATUS_ENABLED=…` line from `backend/.env` (if it exists — grep returned nothing, may have already been removed; confirm)

## 9. Verification

- [x] 9.1 Confirm the dev server starts without errors after the changes
- [x] 9.2 `GET /api/daily-status/counts?date=<today>` → 200 with seven JSON numbers, four buckets summing to `totalMembers`
- [x] 9.3 `GET /api/daily-status/counts?date=<6 days ago>` → 200 (historical dates work)
- [x] 9.4 `GET /api/daily-status?date=<today>&limit=5` → 200 with `meta.total` present
- [x] 9.5 `GET /api/daily-status?date=<today>&status=MISSING_UPDATE` → filtered `meta.total` matches `missingUpdateOnly` from counts
- [x] 9.6 `GET /api/daily-status?date=<today>&search=<partial>` → narrows results case-insensitively
- [x] 9.7 `GET /api/daily-status/members/<known-id>?date=<today>` → 200 with `messages` array
- [x] 9.8 `GET /api/daily-status/members/<unknown-id>?date=<today>` → 404
- [x] 9.9 `GET /api/daily-status/export?date=<today>&format=csv` → CSV file attachment
- [x] 9.10 All daily-status routes → 401 without a token
- [x] 9.11 `POST /api/attendance/submit` accepts `name: "Rakibul Hasan"`, rejects `name: "রাকিবুল হাসান"` with 400
- [x] 9.12 `grep -rn DAILY_STATUS_ENABLED backend/` returns nothing
