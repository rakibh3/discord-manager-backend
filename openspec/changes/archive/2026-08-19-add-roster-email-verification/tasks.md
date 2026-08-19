## 1. Dependencies and configuration

- [x] 1.1 Add `exceljs` and `multer` (v2.x, the Express 5 line) plus `@types/multer` with `bun install`; confirm `multer@^2` resolves, since v1 does not support Express 5.
- [x] 1.2 Add roster tunables to `src/config/index.ts` alongside the existing ones: `ROSTER_IMPORT_MAX_FILE_BYTES` (default 5 MB) and `ROSTER_IMPORT_MAX_ROWS` (default 20000), each Zod-validated with a sane clamp the way `REMINDER_DM_PER_SECOND` is.
- [x] 1.3 Document the two new variables in `.env.example` with their defaults and what they bound.

## 2. Schema

- [x] 2.1 Create `prisma/schema/roster.prisma` with `RosterEntry` — `id`, `email @unique` (normalized), `name`, `phone String?`, `isActive Boolean @default(true)`, `createdAt`, `updatedAt`, mapped to `roster_entries`, indexed on `isActive`. Add a file header comment stating that the model carries **no `guild_id`** and why (an email identifies a person, not a membership — design Decision 1).
- [x] 2.2 Add `RosterImport` to the same file — `id`, `fileName`, `importedById String?` with `onDelete: SetNull` to `User`, `totalRows`, `createdCount`, `updatedCount`, `skippedCount`, `duplicateCount`, `createdAt` — mapped to `roster_imports`, indexed on `createdAt`.
- [x] 2.3 Add `RosterSetting` to the same file — `key String @id` (`'ATTENDANCE_ROSTER'`), `enforceEmail Boolean @default(false)`, `updatedById String?`, `updatedAt` — mapped to `roster_settings`, following the single-row `channel_schedules` / `announcement_templates` pattern.
- [x] 2.4 Add the reverse relations on `User` in `prisma/schema/auth.prisma` for `RosterImport` and `RosterSetting`.
- [x] 2.5 Run `bunx prisma migrate dev --name add_roster` and `bunx prisma generate`; confirm the migration is purely additive (three `CREATE TABLE`s, no `ALTER` on an existing table).

## 3. Email normalization utility

- [x] 3.1 Create `src/utils/rosterEmail.ts` exporting `normalizeRosterEmail(raw: string): string` — trim and lowercase, nothing else. Comment why dot-stripping, `+`-suffix stripping, and provider aliasing are deliberately NOT applied (they merge genuinely distinct addresses and, under an enabled gate, refuse one of the two people).
- [x] 3.2 Export an `isValidRosterEmail` / Zod `rosterEmailSchema` from the same module so import, admin correction, and the submit gate share one definition, in the same spirit as `dhakaDate.ts` and `discordUsername.ts`.

## 4. Roster repository

- [x] 4.1 Create `src/repositories/roster.repository.ts` with the layering rule in its header comment: Prisma only, no `AppError`, no HTTP status codes, no `req`.
- [x] 4.2 Implement `findActiveEntryByEmail(normalizedEmail)` — exact match on the unique column with `isActive: true`, returning the entry or `null`. Comment that it must never use `startsWith`/`contains`, which compile to SQL `LIKE` where `_` is a wildcard.
- [x] 4.3 Implement `countActiveEntries()` for the settings guard and the settings read.
- [x] 4.4 Implement `upsertEntriesInChunks(rows, chunkSize = 200)` — per-email upsert that sets name/phone and forces `isActive: true` on update, chunked 200 per `$transaction` (matching `member.sync.ts`), returning per-chunk created/updated counts and any chunk-level failure rather than throwing.
- [x] 4.5 Implement the admin reads and writes: `listEntries({ search, activeFilter, page, limit })` returning rows plus a total count, `findEntryById`, `updateEntry`, `setEntryActive`.
- [x] 4.6 Implement `createImportRecord(...)` and `listImports({ page, limit })` including the importing administrator.
- [x] 4.7 Implement `getOrCreateSettings()` (materializes the single row with `enforceEmail: false`) and `updateSettings({ enforceEmail, updatedById })`.

## 5. Workbook parsing

- [x] 5.1 Create `src/utils/rosterWorkbook.ts` holding the header alias table (`email` ← email / email address / e-mail / mail; `name` ← name / full name / student name; `phone` ← phone / phone number / mobile / contact / contact number) and the parse function.
- [x] 5.2 Parse with `new ExcelJS.Workbook()` + `workbook.xlsx.load(buffer)` for `.xlsx` and the CSV reader for `.csv`; read the first non-empty row as the header row, trim-and-lowercase each header cell, and map columns by alias — never by position.
- [x] 5.3 Return a discriminated result: a header failure (no recognizable email or name column, carrying the headers found) versus a parsed row set, so the service can turn the first into a whole-file 400 without any write.
- [x] 5.4 For each data row emit `{ rowNumber, name, email, phone }` using `cell.text` for display values; skip rows blank in every recognized column silently; preserve the workbook's own row numbers for reporting.
- [x] 5.5 Enforce `ROSTER_IMPORT_MAX_ROWS` after parsing and before any write, returning a distinguishable over-limit result.
- [x] 5.6 Detect a legacy binary `.xls` upload and return a distinguishable result so the service can answer with the "re-save as .xlsx" instruction — ExcelJS cannot read that format and a bare parse error tells the administrator nothing.

## 6. Roster module — validation and routes

- [x] 6.1 Create `src/modules/roster/roster.validation.ts` with Zod schemas for the list query, the entry patch, the settings patch, and the imports query. Keep the header-alias and file-format messages OUT of Zod — `handleZodValidationError` title-cases every word and would mangle a list of literal tokens.
- [x] 6.2 Create `src/middlewares/upload.ts` (or a local multer instance in the roster routes) using `memoryStorage`, `limits: { fileSize: config.roster.maxFileBytes, files: 1 }`, `.single('file')`, and a `fileFilter` accepting only the spreadsheet/CSV content types.
- [x] 6.3 Translate multer errors (`LIMIT_FILE_SIZE`, `LIMIT_FILE_COUNT`, unexpected field, missing file) into `AppError` 400s at the route/controller boundary so none reaches `globalErrorHandler` as a generic 500.
- [x] 6.4 Create `src/modules/roster/roster.routes.ts` — every route wrapped in `auth(UserRole.ADMIN)`: `POST /import`, `GET /`, `PATCH /:id`, `DELETE /:id`, `PATCH /:id/restore`, `GET /imports`, `GET /settings`, `PATCH /settings`. Header comment stating that the roster holds contact data for thousands of students and that no roster route may ever be public.
- [x] 6.5 Register `rosterRouter` at `/api/roster` in `src/app.ts`, before `notFoundRoute`.

## 7. Roster module — service and controller

- [x] 7.1 Implement `importRoster(file, adminId)` in `src/modules/roster/roster.service.ts`: parse → whole-file 400 on a header or format failure → normalize every email → collapse in-file duplicates keeping the LAST row and recording the row numbers → validate each row → chunked upsert → write the `RosterImport` audit record → return the summary.
- [x] 7.2 Return the summary as a 200 even when rows were skipped, carrying `totalRows`, `created`, `updated`, `skipped`, `duplicates`, the skipped-row list (`rowNumber` + reason), and the repeated-address list. Verify the counts reconcile against the rows read, excluding blank rows.
- [x] 7.3 Implement `listRoster`, `updateEntry` (409 when the new email is held by another entry — match on the serialized `err.meta` containing the email column, not `err.meta.target`, which is `undefined` under `@prisma/adapter-pg`), `deactivateEntry`, and `restoreEntry`.
- [x] 7.4 Implement `getSettings()` returning the flag, the active entry count, and the last editor; and `updateSettings()` which **refuses with a 400 naming the empty roster** when asked to enable while `countActiveEntries() === 0`, and always permits disabling.
- [x] 7.5 Create `roster.controller.ts` — every handler in `catchAsync`, every response through `sendResponse`, no Prisma anywhere in it.

## 8. The submission gate

- [x] 8.1 In `src/modules/attendance/attendance.service.ts`, add a `NOT_ENROLLED_MESSAGE` constant whose wording names only that the address was not recognized — no name, no suggestion, no count.
- [x] 8.2 In `submitAttendance`, read the roster settings row first; when `enforceEmail` is false, skip the roster query entirely and leave the existing behaviour byte-for-byte unchanged.
- [x] 8.3 When enforcement is on, normalize the submitted email with `normalizeRosterEmail` and call `findActiveEntryByEmail` **before** resolving guild membership; throw `AppError(httpStatus.FORBIDDEN, NOT_ENROLLED_MESSAGE)` on a miss, so a never-enrolled address and a deactivated one give an identical refusal.
- [x] 8.4 Confirm the refusal writes nothing — no attendance row in any server — and that the membership 404, the roster 403, the Zod 400, and the duplicate 409 remain four distinguishable outcomes.
- [x] 8.5 Leave the accepted-submission write untouched: `attendances` keeps storing the name, phone, and email the student typed; the roster entry is never copied onto it and is never updated by a submission.
- [x] 8.6 Leave `verifyUser` unchanged — no email parameter, no roster read. Add a comment naming the reason (a 60/min budget on a roster oracle is enumeration of the enrolment roll; design Decision 4).

## 9. Window projection

- [x] 9.1 Add `emailVerificationRequired: boolean` to `TAttendanceWindowResult` and to the explicit return literal in `getAttendanceWindow`, sourced from the same `getOrCreateSettings()` row the gate reads.
- [x] 9.2 Keep the return an explicit field-by-field literal — never a spread — so no roster or editor field can leak onto the one route reachable without a token; confirm no count, address, or `updatedById` appears in the payload.
- [x] 9.3 Confirm the endpoint still performs no Discord call and still ignores query parameters.

## 10. Verification

- [x] 10.1 `bun run lint` and `bun run build` clean.
- [x] 10.2 With enforcement OFF: submit succeeds with an address on no roster; the window reports `emailVerificationRequired: false`. Behaviour identical to before the change.
- [x] 10.3 Import a workbook with headers reordered, mixed case, extra columns, one invalid email, one missing name, blank trailing rows, and one address repeated on two rows — verify the counts, the skipped-row numbers, the repeated-address report, and that the last of the repeated rows won.
- [x] 10.4 Import a workbook with no email column and confirm a 400 naming the headers found and the accepted aliases, with zero rows written.
- [x] 10.5 Upload an oversized file and an over-row-limit file; confirm each is a 400 and neither writes anything.
- [x] 10.6 Attempt to enable enforcement against an empty roster; confirm the 400 and that the setting stays disabled. Import, enable, confirm it succeeds.
- [x] 10.7 With enforcement ON: enrolled email + member handle → 201; unenrolled email → 403 with no attendance row; enrolled email + non-member handle → 404; deactivated entry's address → the same 403 as never-enrolled; a padded, mixed-case enrolled address → accepted.
- [x] 10.8 Confirm the window reports `emailVerificationRequired: true` immediately after arming, with no restart.
- [x] 10.9 Confirm every `/api/roster` route rejects an unauthenticated call before reading any row.
- [x] 10.10 Re-import the same workbook and confirm it is idempotent — updates only, nobody deactivated, roster size unchanged.

## 11. Documentation

- [x] 11.1 Add the roster requests to `postman-collection.json` (import as multipart, list, patch, delete, restore, imports, settings) and document the new response shapes in `API_INTEGRATION.md`, including the 403-versus-404 split on submit and `emailVerificationRequired` on the window.
- [x] 11.2 Add a "Roster email verification" section to `CLAUDE.md` covering: the roster is global with no `guild_id`; the two checks are independent by design and what that does and does not guarantee; enforcement is a stored flag, default off, that cannot be armed against an empty roster and never silently disarms; import upserts and can never deactivate; and the reason `verify-user` takes no email.
- [x] 11.3 Record the rollback in the same section: `PATCH /api/roster/settings { enforceEmail: false }` is the entire rollback for the gate — one request, no deploy.
