## Why

Right now the only thing standing between a stranger and an accepted attendance submission is membership of a Discord server — anyone who is in the guild can submit under any name, phone number, and email they type, and the three contact fields are stored verbatim without ever being checked against anything. The program has an enrolment list living outside the system (a spreadsheet), so the two facts that together identify an actual enrolled student — *this email is on the roll* and *this Discord account is in the server* — are never brought together. Loading that roll into the database and requiring both checks on the write path turns the form from "anyone in the server" into "an enrolled student in the server", without giving students a credential they do not have.

## What Changes

- **A stored roster.** A new `roster_entries` table holds one row per enrolled person: name, normalized email (the unique key), and an optional phone number. It is **global, not per server** — an email address identifies a person, not a membership, so the roster carries no `guild_id` for the same reason `reminder_logs` does not.
- **An admin Excel upload.** `POST /api/roster/import` (`auth(ADMIN)`, multipart) accepts an `.xlsx` workbook or a `.csv` file, maps its header row onto name / email / phone by a case-insensitive alias list, validates every row, and **upserts on normalized email**. Entries already in the database that the sheet does not mention are left untouched — an upload can add and correct, never remove, so a truncated or partial sheet can never lock anyone out.
- **The legacy binary `.xls` format is refused with an instruction, not silently.** The parser (ExcelJS) reads `.xlsx` and `.csv` only; an admin uploading a file saved from an old Excel gets a 400 telling them to re-save it as `.xlsx`, rather than an unexplained parse error.
- **Partial success is a 200 with a summary**, the same rule the multi-guild fan-out already follows: valid rows are imported, invalid rows are reported by sheet row number with the reason, and the response carries `created` / `updated` / `skipped` counts. A workbook whose header row lacks an email column is a 400 before any write.
- **Every import is audited.** A `roster_imports` row records the file name, the administrator, the counts, and the time — so "who changed the roll, and when" is answerable after the fact.
- **Submission gains a second gate.** `POST /api/attendance/submit` now requires *both* that the submitted email matches an active roster entry *and* that the submitted Discord handle resolves to a current member of at least one configured server. The two checks are **independent**: the roster entry does not have to be the same person as the Discord account. Failing each is a **distinguishable outcome** — a handle that is not in any server stays a 404, an email that is not on the roll is a 403 — so the form can tell the student which field to fix without confirming whose email address it is.
- **Enforcement is an explicit, admin-controlled switch, off by default.** Deploying this feature with an empty roster would refuse every one of ~5,000 students with nothing looking wrong, so the check is gated by a stored flag (`roster_settings`, one row, audited by `updatedById`) that starts disabled, and the endpoint that enables it **refuses while the roster holds no active entries**. There is no silent bypass: when the flag is on, an unmatched email is refused, full stop.
- **`GET /api/attendance/window` reports whether the email check is active** (`emailVerificationRequired`), so the form can label the email field correctly. It exposes no roster data and still performs no Discord call.
- **`GET /api/attendance/verify-user` is unchanged** and deliberately gains no email parameter — see the design; putting a roster oracle behind a 60/min budget would let anyone enumerate the roll.
- **Read and correct the roll from the dashboard.** `GET /api/roster` (paginated, searchable), `PATCH /api/roster/:id`, `DELETE /api/roster/:id` (deactivate, never a hard delete), `GET /api/roster/imports`, and `GET|PATCH /api/roster/settings`.
- **Nothing about what is stored on an accepted submission changes.** `attendances` keeps the name, phone, and email the student typed, exactly as now — the roster is a gate, not a source of truth to overwrite the submission with.

## Capabilities

### New Capabilities

- `attendance-roster-directory`: the stored roll of enrolled people — its per-email identity and normalization rules, why it is global rather than per server, activation/deactivation instead of deletion, the lookup that answers "is this email enrolled", and the stored enforcement flag that decides whether that answer gates a submission.
- `roster-spreadsheet-import`: the administrator workbook upload — accepted file types and size bounds, header-to-field mapping, per-row validation, duplicate handling within one sheet, chunked upsert-by-email semantics, the partial-success summary, and the import audit record.
- `roster-admin-http`: the authenticated REST surface over the roster — listing and searching entries, correcting and deactivating one, reading import history, and reading or changing the enforcement flag including the refusal to enable it against an empty roll.

### Modified Capabilities

- `web-attendance-submission`: an accepted submission now requires an enrolled email in addition to guild membership, enforced on the write path only, with the two failures distinguishable from one another and from a format error.
- `public-attendance-window`: the public window projection additionally reports whether email verification is currently required.

## Impact

- **Schema / migration**: a new `prisma/schema/roster.prisma` holding `RosterEntry`, `RosterImport`, and `RosterSetting`. One additive migration; no existing table is altered, and no existing row is rewritten.
- **New dependencies**: a spreadsheet parser (`exceljs`) and a multipart body parser (`multer` v2, which supports Express 5). Both are confined to the import module.
- **New module**: `src/modules/roster/` (routes, validation, controller, service) plus `src/repositories/roster.repository.ts`, registered in `src/app.ts` under `/api/roster`.
- **Modified**: `src/modules/attendance/attendance.service.ts` (the submit gate and the window projection), `src/modules/attendance/attendance.validation.ts` (unchanged field rules; the email field already exists), `src/config/index.ts` (upload size and row caps).
- **Not affected**: member sync, `#daily-update` ingestion, the channel scheduler, the announcement feature, the reminder queue, the dashboard aggregation, and every existing rate-limit budget. No new public endpoint is added, and no additional Discord API call is made anywhere — the roster is entirely a database concern.
- **Operational**: the feature ships inert. An administrator must upload a roll and then explicitly enable enforcement; until they do, submission behaves exactly as it does today.
- **API surface**: `postman-collection.json` and `API_INTEGRATION.md`.
