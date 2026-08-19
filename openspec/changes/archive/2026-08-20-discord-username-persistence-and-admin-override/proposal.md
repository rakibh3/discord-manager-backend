## Why

Today, when a student submits attendance, the system records the Discord-account pairing for the first submission it sees and then ignores every later submission that disagrees. That is safe enough for keeping the report clean, but it leaves the student with no way to say "this is not my account" if the original pairing was wrong — and an administrator with no way to fix a known-bad pairing other than deactivating the entry.

This change makes the Discord pairing student-immutable: once a pairing is recorded, the student must keep submitting under the same handle, and the system refuses submissions that try to change it. Students who genuinely cannot enter their real handle get a "report mismatch" affordance on the attendance form, and that report is surfaced to administrators on the admin dashboard with a final-action endpoint that lets a single administrator update the pairing.

## What Changes

- The attendance submission endpoint rejects, with a distinct outcome, any submission whose submitted handle differs from the Discord account already paired to the submitted address (after normalization). The existing duplicate / validation / not-enrolled / not-in-guild outcomes are preserved and a new one is added: "handle does not match the paired account".
- A pair locked by submission cannot be re-recorded by a later submission. The current first-write-wins rule is unchanged; the new rule is that what is already stored is the only thing that is accepted going forward.
- The attendance form gains a "I cannot enter my real Discord username" checkbox, only visible when the address is paired. When checked, the submission is accepted as today, the discord pairing is left untouched, and a "discord-pairing-mismatch report" is recorded against the pairing.
- A new administrator-only endpoint lists open mismatch reports, paginated and searchable, with the entry, the address, the paired account, the submitted handle, the submission date, and the report time.
- A new administrator-only endpoint lets an administrator take the final action on a report: either re-assign the pairing to the submitted account (the new first-write-wins), or dismiss the report. Re-assigning rewrites the pairing in a single conditional write.
- The existing roster-disord-linking and roster-admin-http specs gain delta requirements describing the validation, the report, and the override. The discord-pairing-mismatch-report spec is new.

## Capabilities

### New Capabilities

- `discord-pairing-mismatch-report`: Records the "user cannot enter their real Discord username" signal from a public submission, makes it visible to administrators on a paginated listing, and exposes the final-action endpoint that re-assigns or dismisses the report.

### Modified Capabilities

- `roster-discord-linking`: Add a requirement that an accepted submission whose submitted handle differs from the recorded pairing is rejected with a distinct outcome, and that the mismatch is reported as an open report rather than silently changing the pairing.
- `web-attendance-submission`: Add a requirement that the public form accepts a "I cannot enter my real handle" flag, that the submission still succeeds in that case, and that the public response shape is unchanged.
- `roster-admin-http`: Add a requirement that the admin engagement listing and mismatched-pairing reports are reachable through the admin-only HTTP surface, and that the override endpoint is reachable from it.

## Impact

- HTTP routes: `POST /api/attendance/submit` gains a new request flag and a new distinguishable outcome; new admin routes `GET /api/roster/discord-mismatch-reports` and `POST /api/roster/discord-mismatch-reports/:id/action` are added.
- Database: a new `discord_pairing_mismatch_reports` table is added, with a status column (`open`, `reassigned`, `dismissed`), the submitting account, the paired account, the submitted expected handle, and the reviewing administrator.
- Code: the submission path runs a new pre-pairing check; the admin path gains a new module for listing and acting on reports.
- Authentication: the new admin endpoints are added to the existing administrator-token middleware; the new public field is unauthenticated like the rest of the submission path.
- Backwards-compatibility: existing submissions whose address is unpaired are unaffected; existing pairings continue to be accepted by submission; existing admin endpoints are unchanged.
