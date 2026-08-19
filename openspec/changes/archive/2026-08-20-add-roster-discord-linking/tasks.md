## 1. Schema and migration

- [x] 1.1 Add `discordUserId String? @unique @map("discord_user_id")` and `linkedAt DateTime? @map("linked_at")` to `RosterEntry` in `prisma/schema/roster.prisma`, with a comment block explaining that the value is a Discord ACCOUNT snowflake (never a `discord_members.id`), why there is no foreign key, why uniqueness is the constraint that stops one account being counted as two enrolled people, and why `linked_at` cannot be replaced by `updated_at`.
- [x] 1.2 Add an index supporting the paired/unpaired split used by the listing filter and the counts query.
- [x] 1.3 Run `bunx prisma migrate dev --name add_roster_discord_link` and `bunx prisma generate`; confirm the migration is purely additive with no data step.
- [x] 1.4 Verify against a local database that many entries can hold `NULL` in `discord_user_id` simultaneously while two entries cannot hold the same non-null value.

## 2. The pairing write

- [x] 2.1 Add `linkEntryToAccount({ normalizedEmail, discordUserId })` to `src/repositories/roster.repository.ts`, implemented as a single `updateMany` scoped `{ email, isActive: true, discordUserId: null }`. Document that the `discordUserId: null` in the WHERE is the claim, in the same family as `markReminderProcessing` and `reclaimFailedDay`, and that a read-then-write check does not survive two submissions in the same millisecond.
- [x] 2.2 Have it return whether a row was claimed, and translate a P2002 on `discord_user_id` into "not claimed" rather than an error — the account already belongs to another entry, which is a determination, not a failure. Keep it free of `AppError` and HTTP status codes, per the repository rule.
- [x] 2.3 Confirm the repository's existing `upsertEntriesInChunks` update payload still names only `name`, `phone`, and `isActive`, and add a comment forbidding the link fields there, naming the failure it prevents (a routine re-import erasing every pairing in bulk).

## 3. Recording the pairing on submit

- [x] 3.1 In `src/modules/attendance/attendance.service.ts`, add a private helper that takes the accepted payload and the resolved member rows, returns early when the rows do not all carry the same `discordUserId` (logging the ambiguity), and otherwise calls `linkEntryToAccount` with `normalizeRosterEmail(payload.email)`.
- [x] 3.2 Call it from `submitAttendance` after `createAttendanceForMembers` resolves and before the return, wrapped so no error escapes. Add a comment stating that it is outside the attendance transaction on purpose, that it runs regardless of `enforceEmail`, and that it must never change the response.
- [x] 3.3 Verify the returned response object is byte-for-byte the shape it had before — no new field, no new status code.
- [x] 3.4 Manually verify the four failure outcomes are still 400 / 403 / 404 / 409 and that none of them attempts a pairing write.

## 4. Sharing the credit sources

- [x] 4.1 Export `accountAttendanceSource`, `accountUpdateSource`, and the range CTE builder (`day_facts` / `account_totals`) from `src/repositories/dailyStatus.repository.ts` without changing their SQL, and note in the file header that a second consumer now exists so "posted a daily update" has one definition.
- [x] 4.2 Confirm no existing daily-status query changed shape, and that the exported sources are still keyed on `discord_user_id` with no `guild_id` and no `is_in_guild` filter.

## 5. The engagement read model

- [x] 5.1 Create `src/repositories/rosterStatus.repository.ts` with a header explaining that `roster_entries` is the driving table because the denominator is enrolment, that unpaired entries survive the LEFT JOIN by design, and that the roster total is deliberately not the dashboard's member total.
- [x] 5.2 Implement `getRosterStatusCounts(period)` for a single date: enrolled total, paired, unpaired, and the four activity buckets across paired entries. Assert in a comment that paired + unpaired equals enrolled and that the buckets sum to paired.
- [x] 5.3 Implement `getRosterStatusPage(period, filters)` for a single date, returning entry fields, pairing state, the servers the paired account is currently in, the day's attendance and daily-update facts, and the status. Use a closed `Prisma.sql` allowlist for sort column and direction; bind every other value.
- [x] 5.4 Implement the range variants on top of the shared range CTEs, reporting attendance days, update days, complete days, and the counted-day denominator, mirroring the dashboard's range figures.
- [x] 5.5 Classify `NEVER_LINKED` when `discord_user_id IS NULL`, and otherwise use the existing status expressions unchanged. Verify a paired account that is currently in no server reports as paired with an empty server list rather than as `NEVER_LINKED`.
- [x] 5.6 List, in a comment above each raw query, every column it depends on — the convention the other raw queries follow, because `$queryRaw` does not break at compile time when a column is renamed.

## 6. Service rules

- [x] 6.1 Add roster-status functions to `src/modules/roster/roster.service.ts`: resolve the period (single date or range), enumerate the counted days with `rangeDays()`, enforce the 92-day cap, and reject a weekday set that leaves zero counted days with an `AppError` explaining why a zero denominator is not a valid report.
- [x] 6.2 Resolve server labels from configuration at serialization time — never persist or store a label — falling back to the live Discord name and then the ID, as the rest of the system does.
- [x] 6.3 Keep every `AppError` in the service; the new repository must contain none.

## 7. HTTP surface

- [x] 7.1 Add query schemas to `src/modules/roster/roster.validation.ts` for the counts, listing, and export endpoints: the date or from/to pair (never both), the optional weekday set, pagination, search, the pairing-state filter, the status filter, the sort allowlist, and the format. Reject an unknown `guildId` parameter explicitly rather than ignoring it.
- [x] 7.2 Add the controllers in `src/modules/roster/roster.controller.ts`, returning through `sendResponse` for counts and the listing, and streaming the export directly as the daily-status export does.
- [x] 7.3 Register `GET /status/counts`, `GET /status/export`, and `GET /status` on `rosterRouter` **before** the `/:id` routes, with a comment naming the trap (`status` matched as an entry ID) that `/settings` already documents.
- [x] 7.4 Confirm every new route carries `auth(UserRole.ADMIN)`.

## 8. Export

- [x] 8.1 Lift the CSV cell escaper out of `src/modules/dailyStatus/dailyStatus.service.ts` into `src/utils/csv.ts` with its formula-injection comment intact, and have the daily-status service import it so exactly one escaper exists.
- [x] 8.2 Implement the roster status CSV writer for both period modes, honouring the same filters as the listing, with a filename naming the period.
- [x] 8.3 Refuse an `xlsx` request with the same 400 and message the daily-status export uses.
- [x] 8.4 Verify an exported value beginning with a formula character, and one containing a comma, a quote, and a newline, all survive a round trip into a spreadsheet application.

## 9. Existing surfaces

- [x] 9.1 Include the pairing fields on the entries returned by `GET /api/roster`, leaving every existing field's name and meaning unchanged.
- [x] 9.2 Confirm `GET /api/attendance/verify-user` still takes no email parameter and returns no roster field, and that `GET /api/attendance/window` still exposes only the `emailVerificationRequired` boolean.
- [x] 9.3 Confirm no daily-status endpoint's figures changed.

## 10. Verification

- [x] 10.1 Submit attendance with an enrolled address and a valid handle; confirm the entry becomes paired and the response is unchanged.
- [x] 10.2 Submit again from the same account under a different enrolled address; confirm both stored pairings are unchanged and the submission still succeeds.
- [x] 10.3 Submit from a second account under an already-paired address; confirm the pairing is unchanged and the submission still succeeds.
- [x] 10.4 Re-import the enrolment spreadsheet after pairings exist; confirm every pairing survives and names and phone numbers still update.
- [x] 10.5 Read `GET /api/roster/status` for a date and confirm an enrolled person who has never submitted appears with `NEVER_LINKED` and zero activity.
- [x] 10.6 Cross-check one paired person's row against `GET /api/daily-status` for the same date and confirm the attendance and daily-update facts agree.
- [x] 10.7 Confirm a range over 92 days, and a weekday set matching no day in the range, are both 400.
- [x] 10.8 Run `bun run lint` and `bun run build`.

## 11. Documentation

- [x] 11.1 Add a "Roster ↔ Discord pairing" section to `CLAUDE.md` covering: the account snowflake and why not a member row, first-write-wins and the scoped claim, that the pairing gates nothing, that an import must never touch it, that an ambiguous handle is not paired, and that no repair path exists yet.
- [x] 11.2 Record in `CLAUDE.md` that the roster's enrolled total and the dashboard's member total count different populations and are not reconciled — alongside the existing note about combined totals versus `byServer`, since it is the same class of number that looks like a bug.
- [x] 11.3 Add the three endpoints to `postman-collection.json`.
