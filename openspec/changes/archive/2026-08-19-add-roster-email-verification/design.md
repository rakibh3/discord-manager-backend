## Context

The public attendance form (`src/modules/attendance/`) holds the only three routes in this API with no `auth()` middleware. What stands in for authentication today is one check: the submitted Discord handle must resolve to a row in `discord_members` with `isInGuild: true` in at least one configured server. The three contact fields the student types — name, phone, email — are validated for format and then stored verbatim on `attendances`, compared against nothing.

That means the current authorization model is "is in the Discord server", and the program's actual enrolment list lives in a spreadsheet outside the system. This change loads that spreadsheet into the database and makes an accepted submission require two independent facts: an enrolled email address, and a Discord account in a configured server.

Constraints inherited from the codebase, all of which shape the decisions below:

- **Golden Rule 3 / 4**: a change that wrongly refuses students locks ~5,000 people out of the form with no error raised anywhere, and nothing on this path may increase Discord API traffic.
- **Multi-server**: one process serves several identical Discord servers. Shared configuration is stored once; per-server facts live on `discord_members`. The design must decide, explicitly, which of the two a roster is.
- **Layering**: controllers never touch Prisma; services own business rules and throw `AppError`; repositories own Prisma and nothing else.
- **`handleZodValidationError` title-cases every word** of a Zod message, so any message whose exact wording matters (a header alias list, a file-format instruction) must be raised as an `AppError` from the service, not authored in a Zod schema.
- The public submit path is rate limited to 5 requests / 15 min per IP on an in-memory, process-local store.

## Goals / Non-Goals

**Goals:**

- Store an enrolment roster of name / email / phone, loadable from an administrator-uploaded spreadsheet.
- Gate `POST /api/attendance/submit` on the submitted email being on that roster, in addition to the existing membership check.
- Make the two failures distinguishable to the form without leaking who is enrolled.
- Make the feature impossible to deploy into a lockout: inert by default, and refusing to arm against an empty roster.
- Keep the roster surface entirely administrator-only, and keep the submission path free of any new external call.

**Non-Goals:**

- **Pairing an email to a Discord account.** Explicitly decided against for this change (see Decision 2). The two checks are independent.
- **Overwriting submitted contact details from the roster.** `attendances` keeps storing what the student typed. The roster is a gate, not a source of truth for the attendance record.
- **Backfilling or validating existing attendance rows** against the roster. Nothing already recorded is re-examined.
- **Roster-driven dashboard figures.** `dailyStatus.repository.ts` is untouched: denominators still come from `discord_members`. Making the roster a denominator is a separate change with its own reconciliation question ("enrolled but never joined Discord" is a real state and needs its own reporting).
- **Exporting the roster**, roster-based deduplication of students, or self-service enrolment.
- **Roster-aware reminders.** The DM target list is unchanged.

## Decisions

### Decision 1: The roster is global, with no `guild_id`

`roster_entries` carries no server identifier, exactly like `reminder_logs`.

*Why:* an email address identifies a **person**, and this program's servers are identical cohorts of the same course with a small overlap. A person enrolled in the program is enrolled, full stop. Adding `guild_id` would make one person two rows whose name and phone number can disagree, and would force the submit path to ask "enrolled *where*" — a question with no answer, since the roster row has no Discord identity to scope it by. It would also mean an email that is on server A's roll but not server B's produces a submission recorded in one server and refused in the other, which is precisely the split-outcome failure the single-transaction fan-out write exists to prevent.

*Alternative considered:* per-server rosters, so each server's admin manages their own roll. Rejected: it multiplies the lockout surface (two places to get wrong instead of one), and the multi-server design already established that shared configuration is stored once — one `channel_schedules` row and one `announcement_templates` row drive every server.

### Decision 2: The email and handle checks are independent, not paired

The roster stores no Discord handle, and the submit path does not require the matched entry to be the same person as the Discord account.

*Why:* this is the user's explicit choice, and it is the option that cannot lock anyone out. The pairing alternatives each fail in a way this project has learned to avoid — requiring a `discordUsername` column in the sheet makes the roll depend on data the program administrator does not reliably have, and every stale or mistyped handle in it becomes a refused student; binding on first use makes the first submission of the term irreversible for that email and gives an attacker who submits early a way to claim someone else's address.

*What is given up, stated plainly:* the security property is "an enrolled person's email address was supplied by someone in the server", not "this enrolled person submitted". Anyone in a configured server who knows any classmate's email address can submit under it. This is a narrowing of today's model (which requires no email at all), not a full identity check, and the design should not be described as one. Pairing remains a clean follow-up: adding a nullable `discord_user_id` to `roster_entries` and tightening the check is additive to everything here.

### Decision 3: Enforcement is a stored flag, default off, that cannot be armed against an empty roster

A `roster_settings` single-row table (`key = 'ATTENDANCE_ROSTER'`, `enforceEmail Boolean @default(false)`, `updatedById`), following the `channel_schedules` / `announcement_templates` pattern: one row, materialized lazily by a `getOrCreateSettings()`, audited by editor.

*Why a DB row and not an env var:* the sequence an administrator actually performs is *deploy → upload the sheet → check it looks right → turn it on*, and the middle two steps happen after the process is running. An env var makes arming the gate a redeploy, and gives no `updatedById`.

*Why default off, and why the enable is refused on an empty roster:* the failure mode being designed against is the one this codebase keeps writing guards for — a change that silently refuses everybody. With the gate on and the roster empty, every student in every server is refused with a correct-looking 403 and the only symptom is a collapse in submission volume. `PATCH /api/roster/settings` therefore counts active entries first and returns a 400 naming the empty roster.

*Deliberately NOT chosen: a silent bypass.* An "if the roster is empty, skip the check" rule inside the submit path would be a gate that disarms itself under a condition nobody is watching. The guard belongs on the arming step, where a human sees the refusal, not on the hot path where nobody does.

### Decision 4: The gate is on `submit` only — `verify-user` gains no email parameter

`GET /api/attendance/verify-user` keeps its handle-only contract.

*Why:* the two public read endpoints carry a 60/min per-IP budget on a **process-local** store; submit carries 5/15min. Accepting an email on the verify endpoint would turn it into a roster oracle answering ~86,000 queries a day per IP, which is enumeration of the enrolment roll of every student in the program — names not included, but the addresses confirmed. Behind the submit budget the same oracle costs 480 queries a day per IP and each one is a write attempt that is logged. The roster is contact data for thousands of students; it does not belong behind the cheap read budget.

*Cost accepted:* the student learns their email is not recognized only on submit, not while typing. The window endpoint's new `emailVerificationRequired` flag lets the form say *up front* that the email must be the enrolled one, which addresses most of the UX gap without the oracle.

*Alternative considered:* accept the email on verify but answer it only in aggregate ("both fields check out") — same oracle, one indirection away. Rejected.

### Decision 5: Refusal is a 403, distinct from the membership 404

| outcome | status | meaning |
|---|---|---|
| malformed field | 400 (Zod) | fix the format |
| handle in no server | 404 | not in the Discord server |
| email not enrolled | **403** | not on the roll |
| already submitted everywhere | 409 | duplicate |

*Why a different status and not just a different message:* the form already branches on status for the 400/404/409 split, and the two new-and-old "we don't know you" cases must not collapse into one, or the student is told to check the wrong field. 403 is the honest code — the request is well-formed and the subject is identified; it is not permitted.

*Uniform refusal within the roster case:* never-enrolled and deactivated produce the identical 403 with the identical message. This is the same collapse `member.repository.findActiveMembersByUsername` already makes for "no row" versus "left the server", and for the same reason: distinguishing them lets anyone confirm that a particular address used to be on the roll.

### Decision 6: ExcelJS + multer 2.x, memory storage, bounded

- **Parsing: `exceljs`.** Maintained, MIT, no native build, and `workbook.xlsx.load(buffer)` reads straight from memory. It reads `.xlsx` and `.csv` but **not** the legacy binary `.xls`, which is why the import spec requires a specific "re-save as .xlsx" refusal rather than letting that file fall through as an unexplained parse error. *Alternative considered:* the `xlsx` (SheetJS) npm package — the registry copy is stale relative to upstream and has carried unpatched advisories; upstream now distributes outside npm, which is not a dependency this project should take on for one endpoint.
- **Upload: `multer` 2.x** (the line that supports Express 5), `memoryStorage`, `limits.fileSize` and `limits.files: 1`, `.single('file')`. Nothing is written to disk: the buffer is parsed and discarded, so there is no temp file holding the contact details of every student and no cleanup path to get wrong. The size limit is enforced by multer *before* the buffer is complete, so an oversized upload never reaches the parser.
- **Bounds:** a file-size cap and a row cap, both in `config/index.ts` with the other tunables (proposed defaults: 5 MB, 20,000 rows). The row cap is a blast-radius control in the same spirit as the 92-day range cap — not a query-cost limit.
- **Multer errors are translated in the service/route boundary**, not left to bubble: a `LIMIT_FILE_SIZE` reaching `globalErrorHandler` unrecognized would surface as a generic 500 on a condition that is plainly a 400.

### Decision 7: Header mapping by alias, whole-file rejection before any write

Headers are read from the first non-empty row, trimmed and lowercased, and matched against an alias table (`email` ← `email`, `email address`, `e-mail`, `mail`; `name` ← `name`, `full name`, `student name`; `phone` ← `phone`, `phone number`, `mobile`, `contact`, `contact number`). Unrecognized columns are ignored.

*Why not by position:* an administrator inserting a column ahead of the others would otherwise load phone numbers into the email column, and every subsequent submission would be refused — a lockout produced by a spreadsheet edit, with nothing in the system looking wrong.

*Why a missing email or name column rejects the whole file before any write:* this is the one class of error where partial success is misleading rather than helpful. Every row would fail identically, so a 200 with 5,000 skipped rows is a worse report than one 400 naming the headers found and the aliases accepted. That message must be an `AppError` from the service — routed through Zod it would come back title-cased as `Email Address`, `E-Mail`, which is exactly the wrong thing to do to a list of literal tokens the admin must type.

### Decision 8: Import upserts and can never remove; batches of 200

Loading is `createMany`-with-skip-duplicates semantics expressed as per-email upserts, chunked **200 rows per `$transaction`** — the same chunk size `member.sync.ts` uses, for the same reason: one transaction across 5,000 rows holds locks on the table the public form is reading.

*Why an import can never deactivate:* a full-replace import needs a departure-guard-style safety threshold to be survivable, and the guard that already exists for `discord_members` is the highest-risk code in this repo precisely because getting mass-deactivation wrong is invisible. Making the import purely additive removes the whole class: the worst outcome of a wrong file is some extra people on the roll, which refuses nobody. Removal stays an explicit single-entry admin action.

*Duplicate address within one sheet:* last row wins, and the repetition is reported with both row numbers. Silently absorbing it would hide a real error in the source spreadsheet; rejecting the whole file for it would be disproportionate.

*Partial success is a 200 with a summary* — the rule already established for multi-server fan-out. Rows really were loaded; an error status invites a re-upload under the false belief that nothing took effect.

### Decision 9: Placement in the existing layering

- `prisma/schema/roster.prisma` — `RosterEntry`, `RosterImport`, `RosterSetting`. A new file in the split-schema directory is picked up automatically.
- `src/repositories/roster.repository.ts` — Prisma only. Holds `findActiveByEmail`, the chunked upsert, the settings read/write, and the active count. It lives in `repositories/` rather than in the module service because the submit path (`attendance.service.ts`) reads it, and the attendance domain already routes its data access through this layer so two definitions of "enrolled" cannot drift.
- `src/modules/roster/` — the four-file module (`routes`, `validation`, `controller`, `service`), registered at `/api/roster` in `src/app.ts`, every route `auth(UserRole.ADMIN)`.
- `src/utils/rosterEmail.ts` — `normalizeRosterEmail()`, the single producer of the stored/compared form, in the same spirit as `dhakaDate.ts` and `discordUsername.ts` being the only producers of their canonical values. Import, admin correction, and the submit gate all call it; a second inline `.toLowerCase().trim()` anywhere is how the constraint and the lookup come to disagree.
- `attendance.service.ts` gains one guard inside `submitAttendance`, placed **after** field validation and **before** the membership resolution is written, plus one field on the window projection.

*Normalization is trim + lowercase only.* No dot-stripping, no `+`-suffix stripping, no provider-specific aliasing: those rules hold for Gmail and not for others, and applying them universally merges two people who hold genuinely distinct addresses — which, under an enabled gate, refuses one of them.

### Decision 10: Order of checks in `submitAttendance`

Roster check first, then membership resolution.

*Why:* the roster check is one indexed read against a local table; membership resolution is a `findMany` plus, on success, an attendance existence read and a transactional multi-row write. Refusing on the cheaper check first does less work per refused request on the one endpoint an unauthenticated stranger can reach. It also keeps the messages unambiguous — a request failing both checks is told about the email, and once corrected is told about the handle, rather than the two competing.

*The one thing this must not do* is skip the roster read when the flag is off in a way that costs a query anyway: the settings row is read first (one row, primary-key lookup), and when enforcement is disabled the roster is not queried at all.

## Risks / Trade-offs

- **Deploying with the gate on and an empty or wrong roster refuses every student, silently.** → Default off; `PATCH /api/roster/settings` refuses to enable against an empty roster; import can never deactivate; `GET /api/roster/settings` reports the active count alongside the flag so the effect is visible before arming.
- **A spreadsheet with a mistyped or missing email column loads garbage and then refuses the affected students.** → Header-alias mapping rather than position; whole-file rejection when the email or name column is unrecognizable; per-row reporting by row number; and because import never removes anyone, a bad file adds noise rather than taking access away.
- **The roster is contact data for thousands of students on an endpoint set that now exists.** → Every roster route is `auth(ADMIN)`; the public window flag is a bare boolean; `verify-user` gains no email parameter; the 403 message names nothing.
- **The independent-checks model does not prove identity** (Decision 2). → Stated in the spec as a deliberate scenario rather than left as an implicit gap, so nobody later reads the feature as an identity check. Pairing is additive if it is wanted.
- **The submit path gains a database read.** → One indexed lookup on a unique column, and only when enforcement is on. No Discord call, no dependency on server count, and nothing added to `verify-user` or `window`, which are the endpoints that actually carry volume.
- **A large workbook parsed in memory.** → Size cap enforced by multer before the buffer completes, row cap enforced after parse and before any write, one file per request, buffer discarded after parsing.
- **The import endpoint is a long-running admin request.** → Chunked at 200 rows per transaction so it never holds one long transaction against the table the public form reads; a failed chunk is reported in the summary while the others proceed.
- **A P2002 on the roster's unique email could surface as the generic "Duplicate Error".** → Note the existing caveat: under `@prisma/adapter-pg`, `err.meta.target` is `undefined`, and the constraint arrives at `meta.driverAdapterError.cause.constraint.fields`. Any roster-specific duplicate message must match on `JSON.stringify(err.meta)` containing the column, the way `attendance.service.ts` does for `attendance_date`.
- **A cached window response could advertise the wrong requirement** if a caching layer is ever put in front of `/api/attendance/window`. → Out of scope today (nothing caches it), but the flag is read from the same stored row the gate reads, so the two cannot disagree at source.

## Migration Plan

1. **Schema.** Add `prisma/schema/roster.prisma`; `bunx prisma migrate dev --name add_roster`; `bunx prisma generate`. Purely additive — three new tables, no existing table altered and no existing row rewritten.
2. **Deploy inert.** With no `roster_settings` row, `getOrCreateSettings()` materializes enforcement **disabled**, and `submitAttendance` behaves exactly as before. The form works unchanged; the only visible difference is `emailVerificationRequired: false` on the window payload.
3. **Load the roll.** An administrator uploads the workbook and reads the summary — created/updated/skipped counts and the skipped-row list — correcting the source sheet and re-uploading as needed. Re-uploading is safe by construction: it upserts and removes nobody.
4. **Verify before arming.** `GET /api/roster?limit=…` and `GET /api/roster/settings` (which reports the active count) confirm the roll matches expectations.
5. **Arm.** `PATCH /api/roster/settings { enforceEmail: true }`. Takes effect on the next submission with no restart.
6. **Rollback.** `PATCH /api/roster/settings { enforceEmail: false }` — one request, immediate, no deploy. That is the entire rollback for the gate; the tables and the admin surface can stay in place harmlessly. A full revert additionally drops the three tables, and because nothing outside the roster module references them, no other feature is affected.

**Front-end coordination:** the form should read `emailVerificationRequired` from `/api/attendance/window` and handle a 403 on submit distinctly from a 404. Arming enforcement before the form ships that branch degrades the message a refused student sees; it does not break the flow.

## Open Questions

- **Should the roster eventually become the dashboard's denominator?** "Enrolled but never joined Discord" is a real and currently invisible state, and the roster is the only place it could be seen. Deliberately out of scope here — it changes figures the multi-server design documents in three places as interlocking, and needs its own change.
- **Default file-size and row caps** are proposed as 5 MB / 20,000 rows against a roll of roughly 5,000. Confirm against the real spreadsheet before shipping.
- **Phone number format on import.** The attendance form enforces the Bangladeshi mobile pattern; the roster currently accepts any non-empty phone value or none. If the source sheet is known to hold clean numbers, tightening import validation to the same pattern is a one-line change — but it would skip rows on a field nothing is gated on, so the default here is lenient.
- **Should `GET /api/roster` be exportable back to a spreadsheet?** Useful for reconciliation, but it is a bulk export of contact data and deserves its own decision.
