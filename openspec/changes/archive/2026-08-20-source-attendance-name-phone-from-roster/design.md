## Context

Today the public attendance form (`POST /api/attendance/submit`) asks for four fields — `name`, `phone`, `email`, `discordUsername` — and the backend stores whatever the student typed. The enrolment roster (`roster_entries`) already holds every student's `name` and `phone` (imported from the spreadsheet and refreshed on every re-import), so the form is asking the student to re-declare information the system already has. When a student types a slightly different name than the one on the roll, the directory entry's `phone` is overwritten from the form but the `name` is not, and the attendance row carries whatever the form supplied — so the dashboard sees one name on the directory and a different name on the day's report.

The fix is to read `name` and `phone` from the roster entry the email already matched, and to refuse those keys on the form so a stale form cannot keep supplying them.

The work is small and constrained to the attendance submission flow. Every other piece of the system — the `verify-user`/`verify-email` endpoints, the schedule window, the multi-server fanout, the unique-constraint duplicate check, the discord-pairing-mismatch report, the roster pairing write, the rate limiters, the controllers, the routes — keeps its current behaviour.

## Goals / Non-Goals

**Goals:**

- The form carries exactly two fields: `email` and `discordUsername` (plus the existing optional `cannotEnterRealDiscordUsername` flag).
- The backend stores the `name` and `phone` it reads from the matched active roster entry, when roster enforcement is enabled.
- The four distinguishable outcomes (validation 400, not enrolled 403, not a member 404, duplicate 409) remain four.
- No schema migration. No new repository. No new endpoint. No change to the public surface outside the submit body shape.

**Non-Goals:**

- Removing the `name` and `phone` columns from `attendances` or `discord_members`. They stay; they just stop being sourced from form input.
- Changing the enrolment import behaviour. The roster continues to be the source of truth for `name` and `phone`; this change does not alter what an import writes.
- Removing `name` or `phone` from the form's UI. The form is out of scope here — the change is to the API contract only.
- Backfilling old attendance rows. Rows already in `attendances` keep whatever they recorded.
- Adding a roster-entry lookup to the `verify-user`/`verify-email`/window endpoints. They continue to look up only what they look up today.
- Changing how the directory's `phone` is sourced from the import path or from the admin's edit-entry path. Only the submit path's behaviour changes.

## Decisions

### The validation schema drops `name` and `phone` and refuses unknown keys

`attendance.validation.ts` keeps `discordUsername` and `email`, keeps the optional `cannotEnterRealDiscordUsername` flag, and drops `name` and `phone`. The schema is set to `strict()` so any other key on the body raises a 400 naming the field — the same way a missing `email` raises a 400 today. Zod's default behaviour strips unknown keys, which would silently accept a stale form; `strict()` turns that into a refused request.

`strict()` is the right call over `passthrough()` because the failure mode of "the form keeps sending fields the API no longer reads" is invisible to the operator. The form already declares its request shape in `API_INTEGRATION.md` and `postman-collection.json`; making the API refuse the old shape is the only way to catch a deployment that ships before the form update.

### The submit payload type drops `name` and `phone`

`TSubmitAttendancePayload` loses both fields. The service signature becomes `submitAttendance({ email, discordUsername, cannotEnterRealDiscordUsername? })`. Every other code path that constructs a payload (there is only one — the controller) is updated in lockstep.

### `name` and `phone` are sourced from the roster entry that the email matched

When `enforceEmail` is on, `assertEnrolled` already returns no value but the calling code has no handle on the matched entry — `findActiveEntryByEmail` is called inside `assertEnrolled` and the result is discarded after the null check. The fix is to refactor `assertEnrolled` into a function that returns the matched entry (or `null` when enforcement is off), and have the submit path carry the entry through to the attendance write.

When `enforceEmail` is off, no entry is looked up, no entry is returned, and the service writes `name: ''` and `phone: ''` (empty strings) onto the attendance row. The columns are non-null in the schema; empty string is the documented "no source" value for an unenrolled submission, matching how the verify-email endpoint already reports a non-verified, non-required answer.

*Why not `null` for the unenrolled case:* the schema has the columns typed `String` (not `String?`). A migration to make them nullable is in scope for nothing else and would change every reader. Empty string is the existing pattern — the form-supplied path never wrote `''`, but neither did the verify path, so no existing code reads it. The migration is no-migration precisely because empty string is acceptable.

*Why not keep the form-supplied `name`/`phone` as a fallback when the roster has nothing:* an unenrolled submission is by definition not tied to a roster row, and a form-supplied value is exactly the drift the change exists to remove. There is no fallback.

### The directory's `phone` is updated from the roster entry, not the form

`createAttendanceForMembers` continues to write `name`/`phone` onto `discord_members`. The values come from the matched roster entry, not from the submission payload. When `enforceEmail` is off, no directory `phone` update is issued at all — the directory's existing `phone` (whatever the most recent source set it to) is left untouched. The directory's `email` continues to be set to the submitted email in both cases, because the email is what the student actually submitted and is therefore the freshest signal.

*Why update `phone` from the roster at all:* an unenrolled member who has previously submitted with a form-supplied phone has whatever phone was last typed. After this change, the directory still carries that phone (the column is not zeroed) but it stops being refreshed by future submissions. The dashboard reads the most-recent value and continues to work; admins who want the directory to reflect the roster's value use the roster re-import, which already overwrites `phone` from the spreadsheet for active entries.

### The `cannotEnterRealDiscordUsername` flag keeps its current shape

The flag is consumed by `assertHandleMatchesPairingIfPaired` after the roster gate has confirmed the address is enrolled. The mismatch path is unchanged: a paired-but-mismatched entry with the flag set still files a report, still records no attendance row, still answers 202 Accepted. The flag is the only field that travels with the submission besides `email` and `discordUsername`.

### No new repository, no new service function, no new endpoint

`rosterRepository.findActiveEntryByEmail` already exists. `attendanceRepository.createAttendanceForMembers` already takes `name`/`phone`. The only changes are to the validation schema, the payload type, the service signature, and the directory update — all within existing files.

## Risks / Trade-offs

- **A roster entry whose `phone` is `null` (a row imported before the column was populated) writes `null` into the directory's `phone` and the attendance row's `phone`.** → The schema allows `phone: String?` on `roster_entries` (verified) but `discord_members.phone` is `String` non-null. Two options: write `''` when the roster entry has no phone, or refuse the submission. Writing `''` is consistent with the unenrolled-submission case and does not invent a new failure outcome; refusing would create a fifth outcome for a problem that is straightforward to fix by re-importing the roster.
- **The form may not be updated in the same release as the backend.** → The schema is `strict()`, so a form that still sends `name`/`phone` gets a 400 with a message naming the field. The form team sees the 400 immediately; the API integration doc and the Postman collection are updated in the same change so there is one canonical reference.
- **The change is conditional on `enforceEmail`, and behaviour without enforcement is a deliberate regression.** → The proposal states this explicitly. With the gate off, an accepted submission no longer carries a name or phone. The PID §3.4 outcomes are unchanged; the stored data shape changes. This is acceptable because the gate being off means the submission is not tied to any enrolled person and there is no roster row to source from. Once the gate is armed, the full shape is restored.
- **A student who is enrolled under one email and submits under a different enrolled email still gets recorded under the second email's roster entry.** → Same as today. The email is what gets matched; the row's `name`/`phone` come from the matched entry; the directory's `email` is updated to the submitted one. This is the existing pairing-independence behaviour and the change does not touch it.
- **A roster re-import that zeroes a `phone` (rare, but possible) carries the new value onto the next attendance row that day.** → This is the desired behaviour. The roster is the source of truth; re-importing with corrections is what propagates them. Existing attendance rows are not retroactively rewritten, which matches the current "form values stay frozen on the row they were typed for" rule.

## Migration Plan

There is no schema migration. Deployment is:

1. Ship the backend change. The submit endpoint now requires `email` and `discordUsername` only and refuses anything else with a 400.
2. Update `API_INTEGRATION.md` and `postman-collection.json` in the same release.
3. Roll the form forward to the two-field payload. Any form still on the four-field payload gets a 400 immediately and is updated.
4. If the form cannot ship in lockstep, leave the four-field form online temporarily — its requests will be refused with a clear error message rather than accepted with stale data.

There is no rollback procedure that needs to be different from the standard redeploy: the old code accepted four fields, the new code accepts two, and the schema does not change. Reverting the backend restores the four-field acceptance without any data side-effects.

## Open Questions

- **Should the form's "I cannot enter my real Discord username" flag be carried forward when the form changes?** The flag's semantics do not depend on `name`/`phone`, so yes — it stays. There is no question here, but it is named because removing two of the four fields could have read as a simplification of the whole payload.
- **Should an unenrolled submission (`enforceEmail: false`) carry the empty-string name and phone, or refuse the submission for lack of identifying information?** This change picks "carry empty strings" because it preserves the four distinguishable outcomes. The other option (a fifth outcome) is rejected on the same grounds as the discord-pairing-mismatch flag — see the existing "the pairing step cannot change the outcome of a submission" requirement, which is the same principle.
- **Should the directory's `phone` column be migrated to nullable?** No — the change is no-migration by design. The directory's `phone` is set to whatever the most recent source supplied and is left at that value when no source is available. A migration is unnecessary and would touch every reader.