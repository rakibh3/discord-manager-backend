/**
 * Test specification for the discord-pairing-mismatch report flow.
 *
 * The project's test framework is not yet wired up. This file documents
 * the unit-test scenarios the OpenSpec change requires, organized by
 * the task ID in the change's `tasks.md`. Each scenario is named after
 * the requirement it covers and carries the inputs, the expected outcome,
 * and the seam it must mock. When a test runner (Jest, Vitest, etc.) is
 * added, the scenarios translate one-to-one into `it(...)` / `describe(...)`
 * blocks.
 *
 * The test seams are the same ones the service already uses:
 *   - `rosterRepository.findActiveEntryByEmail` — drives the gate.
 *   - `memberRepository.findActiveMembersByUsername` — drives the handle
 *     resolution and the membership check.
 *   - `attendanceRepository.createAttendanceForMembers` — drives the
 *     attendance write.
 *   - `discordPairingMismatchReportRepository.createIfAbsent` — drives the
 *     mismatch report write.
 *   - `rosterRepository.linkEntryToAccount` — drives the pairing write.
 *   - The HTTP layer's `auth(UserRole.ADMIN)` middleware — drives the
 *     admin token check.
 *
 * Mocking those seams (rather than running against PostgreSQL) keeps each
 * scenario fast and isolated, the same way the existing repository tests
 * (when added) would.
 */

// ---------------------------------------------------------------------------
// 9.1 First flag-set submission for a paired entry creates an open report
// ---------------------------------------------------------------------------
// INPUT:
//   - Roster entry exists with `discordUserId = "PAIR_ACCOUNT"`.
//   - Submission arrives for that email with `discordUsername = "DIFFERENT"`
//     and `cannotEnterRealDiscordUsername = true`.
//   - `memberRepository.findActiveMembersByUsername("different")` returns
//     one row with `discordUserId = "DIFFERENT_ACCOUNT"`.
//
// EXPECTED:
//   - `submitAttendance` returns the normal accepted-submission response.
//   - `discordPairingMismatchReportRepository.createIfAbsent` is called
//     exactly once with `pairedAccountId = "PAIR_ACCOUNT"`,
//     `submittingAccountId = "DIFFERENT_ACCOUNT"`, and
//     `submissionDhakaDate = today()`.
//   - `rosterRepository.linkEntryToAccount` is NOT called.

// ---------------------------------------------------------------------------
// 9.2 Second flag-set submission on the same day does not create a
//     duplicate open report
// ---------------------------------------------------------------------------
// INPUT:
//   - Open report already exists for the entry on today's Dhaka date.
//   - Second submission arrives with the same mismatch and the flag set.
//
// EXPECTED:
//   - `submitAttendance` returns the normal accepted-submission response.
//   - `discordPairingMismatchReportRepository.createIfAbsent` is called
//     once. The repository returns `null` (the partial-unique-index
//     conflict was swallowed); the service absorbs that as a no-op.
//   - The existing open report is left unchanged.

// ---------------------------------------------------------------------------
// 9.3 Flag-set submission on an unpaired entry does not create a report
// ---------------------------------------------------------------------------
// INPUT:
//   - Roster entry exists with `discordUserId = null`.
//   - Submission arrives with `cannotEnterRealDiscordUsername = true`.
//
// EXPECTED:
//   - `submitAttendance` returns the normal accepted-submission response.
//   - `discordPairingMismatchReportRepository.createIfAbsent` is NOT
//     called. The first-write rule applies.
//   - `rosterRepository.linkEntryToAccount` IS called (existing pairing
//     write path).

// ---------------------------------------------------------------------------
// 9.4 A mismatched submission without the flag is refused with the new
//     outcome
// ---------------------------------------------------------------------------
// INPUT:
//   - Roster entry exists with `discordUserId = "PAIR_ACCOUNT"`.
//   - Submission arrives with `discordUsername = "DIFFERENT"` and
//     `cannotEnterRealDiscordUsername = false` (or absent).
//
// EXPECTED:
//   - `submitAttendance` throws an `AppError` with status 403 and the
//     `HANDLE_DOES_NOT_MATCH_PAIRING_MESSAGE` text.
//   - `attendanceRepository.createAttendanceForMembers` is NOT called.
//   - `discordPairingMismatchReportRepository.createIfAbsent` is NOT
//     called.

// ---------------------------------------------------------------------------
// 9.5 A mismatched submission with the flag is accepted and the report
//     is recorded
// ---------------------------------------------------------------------------
// INPUT:
//   - Same as 9.1.
//
// EXPECTED:
//   - Same as 9.1.

// ---------------------------------------------------------------------------
// 9.6 Report write failure does not change the submission response
// ---------------------------------------------------------------------------
// INPUT:
//   - Submission arrives with the flag set on a paired entry.
//   - `discordPairingMismatchReportRepository.createIfAbsent` throws.
//
// EXPECTED:
//   - `submitAttendance` returns the normal accepted-submission response.
//   - The attendance rows remain committed.
//   - The error is logged (the helper swallows it).

// ---------------------------------------------------------------------------
// 9.7 Admin `reassign` rewrites the pairing when the entry still holds
//     the original
// ---------------------------------------------------------------------------
// INPUT:
//   - Open report exists for an entry whose current `discordUserId`
//     equals the report's `pairedAccountId`.
//   - Administrator submits a `reassign` action.
//
// EXPECTED:
//   - `discordPairingMismatchReportService.actOnReport` returns a
//     success result.
//   - `discordPairingMismatchReportRepository.reassign` performs the
//     conditional `updateMany` and updates the report's status to
//     `REASSIGNED`, with `reviewedByAdminId` and `reviewedAt` set.
//   - HTTP response is 200 with the action result body.
//   - The `discordPairingMismatchReportService.isAccountStillInAnyGuild`
//     helper returns `true` for the submitted account.

// ---------------------------------------------------------------------------
// 9.8 Admin `reassign` is refused as a conflict when the entry no longer
//     holds the original paired account
// ---------------------------------------------------------------------------
// INPUT:
//   - Open report exists, but the entry's current `discordUserId` is
//     NOT the report's `pairedAccountId`.
//
// EXPECTED:
//   - `discordPairingMismatchReportRepository.reassign` returns
//     `{ kind: 'pairing_changed_under_us' }` (the conditional `updateMany`
//     matches zero rows).
//   - Service throws an `AppError` with status 409 and a message naming
//     the pairing conflict.
//   - The report's status remains `OPEN`.
//   - No roster entry is modified.

// ---------------------------------------------------------------------------
// 9.9 Admin `reassign` is refused as non-member when the submitted account
//     is no longer in any configured guild
// ---------------------------------------------------------------------------
// INPUT:
//   - Open report exists.
//   - `memberRepository.findMemberByDiscordUserId` returns `null` (or a
//     row with `isInGuild: false`) for every configured `guildId`.
//
// EXPECTED:
//   - `discordPairingMismatchReportService.actOnReport` throws an
//     `AppError` with status 422 naming the membership check.
//   - `discordPairingMismatchReportRepository.reassign` is NOT called.
//   - The report's status remains `OPEN`.

// ---------------------------------------------------------------------------
// 9.10 Admin `dismiss` leaves the pairing unchanged
// ---------------------------------------------------------------------------
// INPUT:
//   - Open report exists.
//   - Administrator submits a `dismiss` action.
//
// EXPECTED:
//   - `discordPairingMismatchReportRepository.dismiss` is called.
//   - Report's status is set to `DISMISSED`.
//   - `reviewedByAdminId` and `reviewedAt` are set.
//   - Roster entry's `discordUserId` is NOT modified.

// ---------------------------------------------------------------------------
// 9.11 Admin action on a closed report is refused with the current status
// ---------------------------------------------------------------------------
// INPUT:
//   - Report exists with status `REASSIGNED` or `DISMISSED`.
//   - Administrator submits either action.
//
// EXPECTED:
//   - Repository returns `{ kind: 'not_open', currentStatus: ... }`.
//   - Service throws `AppError` with status 409 and a message giving the
//     current status ("This report is already ... and cannot be ...").

// ---------------------------------------------------------------------------
// 9.12 Unknown action is refused with 400
// ---------------------------------------------------------------------------
// INPUT:
//   - Request body is `{ action: "delete" }` or any other value.
//
// EXPECTED:
//   - Validation layer throws `ZodError` for `action` — controller does
//     not run; the central error handler shapes a 400 with the field
//     message.

// ---------------------------------------------------------------------------
// 9.13 Listing without an admin token returns 401
// ---------------------------------------------------------------------------
// INPUT:
//   - `GET /api/roster/discord-mismatch-reports` with no Authorization
//     header.
//
// EXPECTED:
//   - `auth(UserRole.ADMIN)` middleware rejects the request.
//   - HTTP response is 401.
//   - `discordPairingMismatchReportRepository.list` is NOT called.

// ---------------------------------------------------------------------------
// 9.14 Listing filtered by status, search, and date range returns the
//     correct rows
// ---------------------------------------------------------------------------
// INPUT:
//   - Three reports exist:
//       (a) `status = OPEN`, `rosterEntry.email = "a@x"`, `reportedAt`
//           within range.
//       (b) `status = DISMISSED`, `rosterEntry.email = "b@x"`, `reportedAt`
//           within range.
//       (c) `status = OPEN`, `rosterEntry.email = "c@x"`, `reportedAt`
//           outside the range.
//   - Request: `?status=open&search=a&dateFrom=...&dateTo=...`.
//
// EXPECTED:
//   - Repository's `list` is called with the matching filters.
//   - Response items contain report (a) only.
//   - Total is 1.

// ---------------------------------------------------------------------------
// 9.15 Engagement listing reports the open-report count per paired entry
// ---------------------------------------------------------------------------
// INPUT:
//   - Roster entry X is paired and has 2 open reports.
//   - Roster entry Y is paired and has 0 open reports.
//   - Roster entry Z is unpaired (no reports).
//
// EXPECTED:
//   - `getRosterStatusPage` calls
//     `discordPairingMismatchReportRepository.countOpenByEntryIds` with the
//     page's entry IDs.
//   - Row for X carries `openDiscordPairingMismatchReports = 2`.
//   - Row for Y carries `openDiscordPairingMismatchReports = 0`.
//   - Row for Z carries `openDiscordPairingMismatchReports = 0` without
//     requiring a count lookup (the count map returns 0 by absence).
//
// The same expectation applies to `getRosterStatusRangePage` for range
// mode.

void null; // keep this file a module under `verbatimModuleSyntax`