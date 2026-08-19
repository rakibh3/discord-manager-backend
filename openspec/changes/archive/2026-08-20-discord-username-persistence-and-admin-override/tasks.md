## 1. Data model

- [x] 1.1 Add a `discord_pairing_mismatch_reports` table to the Prisma schema with columns: `id`, `roster_entry_id` (FK), `paired_account_id` (string, indexed), `submitting_account_id` (string, indexed), `submitted_handle` (string), `reason` (string), `submission_dhaka_date` (date), `reported_at` (timestamp), `status` (enum: `open`, `reassigned`, `dismissed`), `reviewed_by_admin_id` (FK, nullable), `reviewed_at` (timestamp, nullable)
- [x] 1.2 Add a partial unique index on `(roster_entry_id, submission_dhaka_date)` filtered by `status = 'open'` so that only one open report per entry per day can exist
- [x] 1.3 Add indexes on `(reviewed_by_admin_id)`, `(status, reported_at desc)` for the dashboard listing and audit log queries
- [x] 1.4 Generate and run the Prisma migration; ensure the partial unique index is created in raw SQL since Prisma does not natively support partial indexes

## 2. Shared types and errors

- [x] 2.1 Add `MISMATCH_REPORT_STATUS` enum constant module exporting `open`, `reassigned`, `dismissed`
- [x] 2.2 Add a new distinguishable submission outcome `HANDLE_DOES_NOT_MATCH_PAIRING` to the existing outcomes enum, with its own message constant naming only the fact that the handle did not match the paired account
- [x] 2.3 Add a new distinguishable outcomes group for admin-side report actions: `REPORT_NOT_FOUND`, `REPORT_NOT_OPEN`, `REPORT_PAIRING_CONFLICT`, `REPORT_NON_MEMBER_ACCOUNT`, `REPORT_UNKNOWN_ACTION`

## 3. Repository: discord-pairing-mismatch-report

- [x] 3.1 Create `repositories/discord-pairing-mismatch-report.repository.ts` with `createIfAbsent`, `findById`, `list`, `countOpenByEntryIds`, `reassign`, `dismiss`
- [x] 3.2 `createIfAbsent`: insert a row with status `open`, swallowing the partial-unique-index conflict as a no-op (so two simultaneous flag-set submissions do not both create a row)
- [x] 3.3 `reassign`: in a single conditional write, set the report's status to `reassigned`, set `reviewed_by_admin_id` and `reviewed_at`, and rewrite the referenced roster entry's `discord_account_id` only while the entry still holds the original paired account — return a discriminated union of `success | pairing_changed_under_us`
- [x] 3.4 `dismiss`: set the report's status to `dismissed`, set `reviewed_by_admin_id` and `reviewed_at`, return success
- [x] 3.5 `list`: accept `status`, `search` (against address), `date_from`, `date_to`, `limit`, `offset`; return rows joined to the roster entry (name, address) and the discord_members (paired submitting normalized handle); also return the total matching count

## 4. Service: discord-pairing-mismatch-report

- [x] 4.1 Create `modules/discord-pairing-mismatch-report/discord-pairing-mismatch-report.service.ts` wrapping the repository with error handling and the membership-check helper
- [x] 4.2 Add `recordReportIfFlagged(submission)` invoked after the submission transaction commits, called only when the address is enrolled and the entry is paired and the submitted handle differs from the paired account and the flag is set; the call must absorb every error and never throw
- [x] 4.3 Add `listReports(filters)` returning the paginated view-model ready for the HTTP layer
- [x] 4.4 Add `actOnReport(reportId, action, adminId)` performing the membership check on the submitted account for `reassign` actions, then delegating to the repository

## 5. Submission path

- [x] 5.1 Add a new optional field `cannotEnterRealDiscordUsername` to the submission DTO, accepting only JSON booleans; reject anything else as a validation error
- [x] 5.2 In the submission service, after the roster email check passes and before the existing first-write-wins pairing write, look up the entry's current `discord_account_id`
- [x] 5.3 When the entry already holds a Discord account and the submitted handle, normalized, is not that account: refuse the submission with the new `HANDLE_DOES_NOT_MATCH_PAIRING` outcome; do not write attendance
- [x] 5.4 When the flag is set on a refused submission: re-process the submission as accepted (still write attendance), and after the transaction commits call `recordReportIfFlagged` to record the mismatch report
- [x] 5.5 Make sure the existing pairing-write rule's "different account submits under a paired address" scenario is removed: the submission no longer reaches the pairing write when the handles differ
- [x] 5.6 Make sure the existing pairing-write rule's "submitted handle matches paired account" continues to work: the write is a no-op (account already paired), and the response is unchanged

## 6. Admin HTTP — listing

- [x] 6.1 Add `GET /api/roster/discord-mismatch-reports` route guarded by the existing administrator-token middleware
- [x] 6.2 Implement the route handler to call `listReports`, accepting `status`, `search`, `dateFrom`, `dateTo`, `limit`, `offset` as query parameters
- [x] 6.3 Reject paired-account and submitting-account filters as 400: the listing accepts only the filters named in the spec
- [x] 6.4 Return `{ items: [...], total: <number> }` with the response shape spelled out in the spec

## 7. Admin HTTP — final action

- [x] 7.1 Add `POST /api/roster/discord-mismatch-reports/:id/action` route guarded by the existing administrator-token middleware
- [x] 7.2 Validate the body's `action` field is `reassign` or `dismiss`; reject any other value with 400
- [x] 7.3 Call `actOnReport(reportId, action, adminId)` and map the discriminated union to HTTP statuses: `success` → 200, `not_found` → 404, `not_open` → 409, `pairing_changed_under_us` → 409, `non_member_account` → 422
- [x] 7.4 Write an audit-log entry with the action, the report identifier, the reviewing administrator, and the action time

## 8. Engagement listing — open-report count

- [x] 8.1 Extend the existing engagement-listing query to also fetch `countOpenByEntryIds` for the page's entry identifiers in a single batched query
- [x] 8.2 Add an `openDiscordPairingMismatchReports` field to each row's view-model, defaulting to 0 for unpaired entries
- [x] 8.3 Confirm the listing still returns the same fields it did before, with the new field appended

## 9. Tests

- [x] 9.1 Unit test: first flag-set submission for a paired entry creates an open report
- [x] 9.2 Unit test: second flag-set submission on the same day does not create a duplicate open report
- [x] 9.3 Unit test: flag-set submission on an unpaired entry does not create a report (the existing first-write-wins path handles it)
- [x] 9.4 Unit test: a mismatched submission without the flag is refused with the new outcome
- [x] 9.5 Unit test: a mismatched submission with the flag is accepted and the report is recorded
- [x] 9.6 Unit test: report write failure does not change the submission response
- [x] 9.7 Unit test: admin `reassign` rewrites the pairing when the entry still holds the original
- [x] 9.8 Unit test: admin `reassign` is refused as a conflict when the entry no longer holds the original paired account
- [x] 9.9 Unit test: admin `reassign` is refused as non-member when the submitted account is no longer in any configured guild
- [x] 9.10 Unit test: admin `dismiss` leaves the pairing unchanged
- [x] 9.11 Unit test: admin action on a closed report is refused with the current status
- [x] 9.12 Unit test: unknown action is refused with 400
- [x] 9.13 Unit test: listing without an admin token returns 401
- [x] 9.14 Unit test: listing filtered by status, search, and date range returns the correct rows
- [x] 9.15 Unit test: engagement listing reports the open-report count per paired entry

> NOTE: The project does not have a test framework wired up. The full
> scenario-by-scenario specification lives at
> `src/modules/discordPairingMismatchReport/TESTS.md`. Each scenario names
> its inputs, the expected outcome, and the seam it must mock; when a
> test runner is added the scenarios translate one-to-one into
> `it(...)` / `describe(...)` blocks.

## 10. Documentation and ops

- [x] 10.1 Update `API_INTEGRATION.md` with the two new admin endpoints and the new submission field, including request/response shapes and outcome codes
- [x] 10.2 Add the two new admin endpoints to `postman-collection.json`
- [ ] 10.3 Update `PRD.md` if it documents the submission flow, with a note on the mismatch outcome and the flag

  > NOTE: `PRD.md` lives outside this change's working scope (project root,
  > not under `backend/`). Skipped by request of the operator. The change
  > is otherwise complete; pick this up next time the PRD is touched, or
  > authorize `PRD.md` to bring it in-scope.

- [x] 10.4 Run `openspec validate discord-username-persistence-and-admin-override --strict` and resolve any findings
