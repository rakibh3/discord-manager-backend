## Why

The duplicate-detection path on `/verify-user` and `/submit` is keyed solely on the Discord handle: any prior attendance row for the resolved members counts as "already submitted". A Discord username, however, is not a unique account — two students can claim the same display string, and the same handle can resolve to two `discord_members` rows (one per configured server). When this widens out to a roster-paired email, the result is a student being told "you've already submitted today" for a handle that another, unrelated student owns — or, worse, the form rendering the "already submitted" badge before the submit even runs.

The acceptance check is intentionally pairing-blind and stays that way: submitting under one enrolled address together with another student's handle is still accepted by the existing flow. The pairing-aware rule applies only to the duplicate-detection read, where the question is narrower: "is this prior row attributable to this email+handle combination?".

## What Changes

- Make the duplicate-detection read on `verifyUser` and `submitAttendance` pairing-aware: only prior attendance rows whose `member_id` belongs to a member whose `discord_user_id` matches the matched roster entry's paired account count as a duplicate for the email+handle combination on this submission.
- Add an optional `email` query parameter to `GET /api/attendance/verify-user`. When the email is supplied, the email is on the roster, and the entry is paired with a Discord account, the `alreadySubmitted` answer is restricted to that paired account. When the email is supplied but the entry is unpaired, the answer is `alreadySubmitted: false` regardless of any prior rows — without a recorded link, no prior row can be attributed to this email. Without the email, the prior handle-only behaviour applies.
- Restrict the pairing-aware rule to the `enforceEmail: true` configuration. With the gate off, the system has no record of pairings to consult, and refusing to count prior rows here would silently turn duplicate submissions into fresh ones.
- The acceptance decision on `submitAttendance` is unchanged. A submission whose email is paired with a different account than the submitted handle still runs the existing pairing-mismatch flow (refused unless the flag is set). The pairing-aware rule here is purely about the duplicate read.

## Capabilities

### Modified Capabilities

- `web-attendance-submission`: the duplicate-detection read on `verifyUser` and `submitAttendance` is now pairing-aware. `verifyUser` accepts an optional `email` parameter. The acceptance decision is unchanged.

## Impact

- **Schema**: none. The pairing state already lives on `roster_entries.discord_user_id`; no new column or table.
- **Touched code**:
  - `src/modules/attendance/attendance.service.ts` — new `resolvePairingMode` helper that returns one of three modes (`unrestricted` / `empty` / `linked`) for the duplicate read. `verifyUser` accepts an optional `rawEmail` and reads the roster setting once. `resolveEnrollment` now returns `{ entry, enforceEmail }` so the submit path can thread `enforceEmail` to the duplicate helper without a second read.
  - `src/modules/attendance/attendance.validation.ts` — `verifyUserQuerySchema` accepts an optional `email` field, validated the same way as the submit endpoint's `email`.
  - `src/modules/attendance/attendance.controller.ts` — `verifyUser` passes `req.query.email` through to the service.
- **API surface**: `GET /api/attendance/verify-user` accepts an optional `email` query parameter. The response shape is unchanged. The new field is additive; callers that omit it see the prior behaviour.
- **Performance**: the duplicate read gains one indexed roster lookup on `/verify-user` when `email` is supplied. On `/submit` the roster entry is already resolved by the gate, so the work is reused.
- **Frontend**: optional. The form can stop computing the "already submitted" badge from the username alone and instead pass the email through to `verifyUser`. The submit path is already correct: it carries both fields and the duplicate is handled on the write.
- **Docs**: `CLAUDE.md` gains a note on the pairing-aware duplicate rule. `API_INTEGRATION.md` documents the new `email` parameter on `verify-user`.
