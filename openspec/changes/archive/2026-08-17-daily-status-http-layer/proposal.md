## Why

The `daily-status` feature's query layer (`dailyStatus.repository.ts`) is complete and tested, but it has no HTTP layer — no routes, controller, service, or validation. The frontend is fully built against the documented API contract and blocked behind a feature flag (`DAILY_STATUS_ENABLED`). Until these routes ship, the entire daily-status page renders a "not yet available" placeholder. Separately, the attendance name validation accepts non-Latin scripts the product disallows, and a dead `.env` line suggests the feature is already live when it is not.

## What Changes

- **Add the `dailyStatus` module** (`src/modules/dailyStatus/`) with validation, service, controller, and routes — four GET endpoints serving the dashboard's overview counts, paginated member table, single-member detail with messages, and filtered CSV/XLSX export.
- **Register `dailyStatusRouter`** in `src/app.ts` under `/api/daily-status`.
- **Add `getDailyStatusForMember`** to `dailyStatus.repository.ts` — a single-member query returning the same row shape as the page query plus that day's messages, so the status derivation stays in one place.
- **Tighten the name regex** in `attendance.validation.ts` from `[\p{L}\s]+` to `[A-Za-z\s]+` — English-only by product decision, matching the frontend's existing constraint.
- **Remove `DAILY_STATUS_ENABLED`** from `backend/.env` — it gates the frontend, not the backend, and nothing in `backend/src/` reads it.

## Capabilities

### New Capabilities
- `daily-status-http`: The HTTP layer (routes, validation, controller, service) that exposes `dailyStatus.repository` to the admin dashboard, including a filtered file export endpoint.

### Modified Capabilities
- `web-attendance-submission`: Name field validation tightened from Unicode letters to ASCII Latin letters only.
- `daily-status-aggregation`: New single-member query added to the repository for the member-detail endpoint.

## Impact

- **`src/modules/dailyStatus/`** — four new files following the `reminder`/`schedule` module pattern.
- **`src/app.ts`** — one import and one `app.use` line.
- **`src/repositories/dailyStatus.repository.ts`** — one new exported function (`getDailyStatusForMember`).
- **`src/modules/attendance/attendance.validation.ts`** — one regex change on line 53.
- **`backend/.env`** — one line removed.
- **No schema, migration, or frontend changes.**
- **Dependencies:** May need `csv-stringify` (or similar) and `exceljs` for the export endpoint. Both are stream-capable.
