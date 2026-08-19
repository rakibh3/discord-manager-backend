## Why

The public attendance form asks every student for their full name and phone number on every submission, even though the enrolment roster (`roster_entries`) already holds both — imported from the spreadsheet and refreshed on every re-import. A student whose roster row was just seeded by an admin therefore types the same name they enrolled with, and a different spelling on the form silently replaces the directory's value on the next accepted submission. Asking the form to collect what the system already has is a redundant input that is the most common source of contact-detail drift in the directory.

## What Changes

- Remove `name` and `phone` from the public attendance submission payload. The form SHALL accept exactly `email` and `discordUsername` (plus the existing optional `cannotEnterRealDiscordUsername` flag). The backend SHALL reject any submission carrying `name` or `phone` as a 400 validation error — extra keys are deliberately refused, not silently ignored, so an out-of-date form cannot keep posting fields the system no longer reads.
- **BREAKING**: The `submitAttendanceValidationSchema` drops the `name` and `phone` fields and gains a strict `.strict()` (or equivalent) rejection of unknown keys. `TSubmitAttendancePayload` drops `name` and `phone`. The submit endpoint's request body shrinks from four required fields to two.
- Resolve the student being recorded by looking up the active roster entry that holds the submitted email (when roster enforcement is enabled) and reading its stored `name` and `phone`. When enforcement is disabled, no roster entry is consulted and the attendance row is written without a name or phone — same shape as a roster-on write, just empty.
- Write `name` and `phone` onto the attendance row and onto the member directory entries in the exact same way the form-supplied values were written before — denormalized on the attendance row, carried onto `discord_members`. The schema does not change; only the source of the values does.
- Stop updating the member directory's `phone` column from attendance submissions when roster enforcement is disabled, since no roster entry exists to source the value from. (When enforcement is enabled, the directory update is whatever the matched roster entry holds — and the entry is the source of truth, so this is a no-op consistency move rather than a new behaviour.)
- Keep every other piece of the attendance flow exactly as it is: handle normalization, format validation, multi-server fanout, the membership re-check on the write path, the duplicate-by-unique-constraint rule, the atomicity of the per-server writes, the contact-details carry onto the directory, the discord-pairing-mismatch report, the pairing write, and the four distinguishable outcomes (validation 400, not enrolled 403, not a member 404, duplicate 409).
- Keep the verify-user and verify-email endpoints unchanged. Keep `GET /api/attendance/window` unchanged. Keep all admin routes unchanged.

## Capabilities

### New Capabilities

None. No new surface is being introduced — the form simply collects two fields instead of four, and the values for the other two are read from a table that already exists.

### Modified Capabilities

- `web-attendance-submission`: the requirement on what the submission payload must carry changes. The "Attendance submissions are validated field by field" requirement drops the name and phone rules; a new requirement forbids those keys; the "An accepted submission records the day's attendance" requirement changes from "retaining the name, phone, and email exactly as submitted" to "carrying the roster entry's stored name and phone onto the row, or recording no name and no phone when enforcement is disabled". The "Contact details are carried onto the member directory entry" requirement changes from "the submitted phone number and email address" to "the roster entry's stored phone number and the submitted email address" (when enforcement is enabled), or no directory phone update at all (when enforcement is disabled).

## Impact

- **Schema**: no migration. The `attendances` columns `name` and `phone` and the `discord_members` columns `name` and `phone` already exist. The directory's `phone` is now sourced from the roster rather than from submissions, but the column itself does not move.
- **Touched code**: `src/modules/attendance/attendance.validation.ts` (schema loses `name`/`phone` and gains strict-unknown-key rejection), `src/modules/attendance/attendance.service.ts` (drops `name`/`phone` from the payload type, reads them from the roster entry, threads them into the attendance row and the directory update), `src/repositories/attendance.repository.ts` (the input type and the per-server transaction still take `name`/`phone` — no signature change; what changes is who supplies them), `src/interface/discordPairingMismatchReport.ts` and `src/repositories/discordPairingMismatchReport.repository.ts` are untouched.
- **No new code paths, no new routes, no new repositories.** A `findActiveEntryByEmail` call already runs on the enforceEmail path — the roster entry is in memory by the time the write happens.
- **Behaviour change is conditional on `enforceEmail`.** When the gate is on, an accepted submission records the roster entry's name and phone. When the gate is off, an accepted submission records no name and no phone — a deliberate regression in stored information, accepted because the gate being off means the submission has not been authoritatively tied to any enrolled person and there is no roster row to source from.
- **Rate limiters and middleware unchanged.** The form has two fewer fields to validate; the per-IP budgets and the limiter keying do not move.
- **Docs**: `API_INTEGRATION.md` loses the `name`/`phone` columns from the submit body table; `CLAUDE.md` notes the roster-sourced contact details; `postman-collection.json` drops `name` and `phone` from the submit example.