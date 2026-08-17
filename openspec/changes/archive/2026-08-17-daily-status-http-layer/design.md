## Context

The `dailyStatus.repository.ts` query layer is complete — it exports `getDailyStatusPage`, `getDailyStatusCounts`, and `listMembersMissingUpdate`. The reminder module already consumes `listMembersMissingUpdate`. However, no HTTP layer exists to expose the other two functions (plus a new single-member detail) to the admin dashboard. The frontend is fully built against the documented API contract and gated by `DAILY_STATUS_ENABLED` in `frontend/.env.local`.

The codebase follows a strict module pattern: `validation → service → controller → routes`, each module under `src/modules/<name>/`. Routes are registered in `src/app.ts`. Admin routes use `auth(UserRole.ADMIN)`, query parameters use `validateQuery`, request bodies use `validateRequest`, and all JSON responses go through `sendResponse`.

Additionally, the attendance name validation (`attendance.validation.ts:53`) uses `[\p{L}\s]+` (Unicode-wide) but the product requires English-only names. The frontend already enforces `[A-Za-z\s]+`. A dead `DAILY_STATUS_ENABLED` line in `backend/.env` has no consumer.

## Goals / Non-Goals

**Goals:**
- Expose `dailyStatus.repository` over four admin-only GET endpoints matching the documented frontend contract.
- Handle the `BigInt → number` conversion in the service/controller so `JSON.stringify` does not throw.
- Rename `bothCompleted → bothComplete` and `submittedAt → attendanceSubmittedAt` at the HTTP boundary so the API matches the frontend's field names.
- Add a single-member detail endpoint that includes daily-update messages for one member on one date.
- Add a filtered CSV/XLSX export endpoint that honours the same `status`/`search` filters as the list endpoint.
- Tighten the attendance name regex to `[A-Za-z\s]+`.
- Remove the dead `.env` line.

**Non-Goals:**
- No changes to the repository SQL or Prisma schema.
- No frontend changes — the frontend is already built.
- No new database migrations.
- No SSE/WebSocket streaming — these are standard request/response endpoints.
- No `includeDeparted`, `sortBy`, or `sortDir` query params initially (the frontend doesn't send them; defaults are correct).

## Decisions

### 1. Module structure mirrors `reminder` and `schedule`

**Decision:** Create `src/modules/dailyStatus/` with four files: `dailyStatus.validation.ts`, `dailyStatus.service.ts`, `dailyStatus.controller.ts`, `dailyStatus.routes.ts`.

**Rationale:** Every existing module follows this exact pattern. No reason to deviate.

### 2. Field renames and BigInt conversion live in the service, not the controller

**Decision:** The service returns the API-shaped objects. The controller is a thin passthrough.

**Rationale:** The controller in this codebase is purely HTTP plumbing (`catchAsync`, `sendResponse`, `readPaging`). Business-level transformations — even trivial ones like `Number(bigint)` and field renames — belong in the service so the controller stays mechanical. This matches how `reminder.service.ts` assembles its response objects.

### 3. Export uses streaming, not in-memory buffering

**Decision:** The export endpoint streams rows rather than loading all into memory.

**Rationale:** `getDailyStatusPage` clamps `limit` to 500 internally, so exporting 5,000+ members requires paging through the repository. Streaming row-by-row avoids a spike in heap usage proportional to guild size. For CSV, Node's built-in `Readable` plus manual serialization is sufficient — no new dependency required. For XLSX, `exceljs` supports streaming writes.

**Alternative considered:** A single unpaginated query. Rejected because it would require a new repository function that bypasses the `limit` clamp, and the streaming approach works with the existing API.

### 4. CSV formula injection prevention

**Decision:** Prefix any cell value starting with `=`, `+`, `-`, or `@` with a single quote `'`.

**Rationale:** The export includes user-submitted names. Without this, a name like `=CMD(...)` would execute as a formula when opened in Excel.

### 5. Single-member detail adds `getDailyStatusForMember` to the repository

**Decision:** Add a new repository function rather than composing the single-member view from `getDailyStatusPage({ search: memberId })` in the service.

**Rationale:** The status derivation CASE expression must stay in one place. Reusing the full page query with a filter would work functionally but would scan the full join unnecessarily. A targeted single-member query is cleaner and can 404 properly when the member doesn't exist.

### 6. No new npm dependencies for CSV export

**Decision:** Implement CSV serialization manually. Only add `exceljs` if XLSX support is needed.

**Rationale:** CSV is trivial to serialize (quote fields containing commas/newlines, escape quotes). Adding a dependency for it is unnecessary overhead. The frontend sends `format=csv`, so that's the priority path.

### 7. Name validation change is a single regex swap

**Decision:** Replace `/^[\p{L}\s]+$/u` with `/^[A-Za-z\s]+$/` and update the error message to say "English letters and spaces only".

**Rationale:** The frontend already rejects non-Latin input with the same regex. The backend regex was Unicode-wide but also self-inconsistent (it accepts `\p{L}` but not `\p{M}`, so Bengali vowel signs fail while consonants pass). The product decision is English-only.

## Risks / Trade-offs

**[Risk] Export of 5,000+ members may be slow** → The streaming approach mitigates memory pressure. The underlying SQL is the same indexed query the dashboard already uses. If it becomes a concern, a background job can be added later without changing the API contract.

**[Risk] Field rename drift between repository and API** → The rename is done in one place (the service) and documented in the spec. The alternative — renaming at the repository level — would break the reminder module which also consumes the repository.

**[Risk] XLSX support requires a new dependency (`exceljs`)** → The frontend currently requests `format=csv` only. XLSX can be added later. For now, implement CSV and return 400 for `format=xlsx` if `exceljs` is not yet installed, or implement both if the dependency is acceptable.

**[Risk] `pageQueryShape` is not exported from `reminder.validation.ts`** → It's a plain object spread, not a named export. The daily-status module will define its own identical shape or we export the shape from reminder. Defining it locally avoids coupling two unrelated modules; a shared utility can be extracted later if a third module needs it.
