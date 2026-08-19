# Tasks

## 1. Add `resolvePairingMode` helper

In `src/modules/attendance/attendance.service.ts`, add a `TPairingMode` discriminated union with three kinds (`unrestricted`, `empty`, `linked`) and a `resolvePairingMode(email, members, enforceEmail)` helper that returns one of them based on the supplied email, the live roster settings, and the resolved member rows. Document each mode in the helper's header comment.

## 2. Refactor `resolveEnrollment` to return the gate flag

Change `resolveEnrollment(email)` from returning `RosterEntry | null` to returning `{ entry: RosterEntry | null, enforceEmail: boolean }`. The submit path needs `enforceEmail` to pass to `resolvePairingMode` without re-reading the settings.

## 3. Update `verifyUser` to be pairing-aware

- Accept an optional second parameter `rawEmail: string | null = null`.
- Read `enforceEmail` from `rosterRepository.getOrCreateSettings()` once and pass it through.
- After resolving members, call `resolvePairingMode(rawEmail, members, enforceEmail)` and use the returned `memberIds` set (or `new Set()` for `empty` mode) to filter the existing rows before computing `submittedMemberIds`.
- Update the header comment to describe the three modes and when each applies.

## 4. Update `submitAttendance` to be pairing-aware

- Destructure `{ entry: rosterEntry, enforceEmail }` from `resolveEnrollment`.
- After resolving members, call `resolvePairingMode(payload.email, members, enforceEmail)` and use the returned set to filter the existing rows before computing `submittedMemberIds` and `pending`.
- The duplicate refusal message and the per-server `recorded` / `alreadySubmitted` fields in the response continue to use the pairing-filtered set.

## 5. Add optional `email` to `verifyUserQuerySchema`

In `src/modules/attendance/attendance.validation.ts`, extend `verifyUserQuerySchema` with an optional `email` field. Validate with the same `z.string().trim().pipe(z.email())` chain used by the submit schema so a malformed value fails here the same way it would fail at submit.

## 6. Pass `email` through the verify-user controller

In `src/modules/attendance/attendance.controller.ts`, pass `req.query.email` (or `null` when absent or not a string) to `attendanceService.verifyUser`.

## 7. Type-check and lint

Run `bunx tsc --noEmit` and `bunx eslint src/modules/attendance/` and confirm both pass with no warnings.

## 8. Document in `CLAUDE.md` and `API_INTEGRATION.md`

- `CLAUDE.md`: add a paragraph under the attendance-form section describing the pairing-aware duplicate rule and when each of the three modes applies.
- `API_INTEGRATION.md`: document the new optional `email` parameter on `GET /api/attendance/verify-user` with the matching behaviour described above.