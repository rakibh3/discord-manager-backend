# Pairing-aware duplicate detection — design

## Background

A Discord username is not a unique account. Two students can claim the same display string, and a single account resolves to one `discord_members` row per configured server. The existing duplicate-detection read on `/verify-user` and `/submit` is keyed on the resolved `discord_members` rows for the handle alone: any prior attendance row for any of those rows counts as a duplicate.

This was correct when no pairing existed. With the roster holding an email-to-account pairing, the duplicate question becomes narrower: "is this prior row attributable to this email+handle combination?". The answer is "yes" only when the prior row's member row belongs to the same Discord account the roster entry is paired with.

The acceptance decision stays pairing-blind: a submission whose email is paired with a different account still flows through the existing pairing-mismatch rule (refused unless `cannotEnterRealDiscordUsername` is set). The pairing-aware rule is purely a read on the duplicate path.

## The three modes

The new `resolvePairingMode` helper computes one of three states for a `(email, members)` pair, given the live `enforceEmail` setting:

| Mode           | When                                                                | `memberIds`            | Effect on duplicate read                          |
| -------------- | ------------------------------------------------------------------- | ---------------------- | -------------------------------------------------- |
| `unrestricted` | No email supplied **OR** `enforceEmail: false`                      | All resolved members   | Prior behaviour: any row for any member counts    |
| `empty`        | Email supplied, gate on, no roster entry **OR** entry is unpaired   | `Set()`                | No prior row counts; `alreadySubmitted: false`    |
| `linked`       | Email supplied, gate on, roster entry paired with a Discord account | Members whose `discord_user_id` matches the paired account | Only those members' rows count           |

`unrestricted` and `empty` both have an empty-or-everything `memberIds` set, but they mean different things: `unrestricted` falls through to the prior behaviour; `empty` suppresses the duplicate read entirely. The caller treats `empty` as "no prior row can be attributed" and `unrestricted` as "no link information is being consulted, fall back".

### Why `empty` is empty, not "all members"

A supplied-but-unpaired email is not the same as a missing email. The form passed an email — we cannot say that email "belongs to" any handle, so no prior row attributable to the handle is attributable to that email. Reporting `alreadySubmitted: true` for an unpaired email would tell the form "this email+handle pair is done", which would block the very next submission from creating a pairing (the existing first-write rule). Conversely, when `enforceEmail: false`, the system has no roster concept to consult and would silently turn duplicates into fresh rows if `empty` were used; the prior behaviour is restored.

### Why the gate matters

With `enforceEmail: false`, the roster is decorative. No pairings are recorded against it, and the `discord_user_id` on `roster_entries` may be stale or empty for everyone. Applying the pairing-aware rule would either give an empty `memberIds` (because `discord_user_id` is null) or a `linked` set keyed on unverified data. The unenforced path keeps the prior behaviour.

## Why not gate by `rosterEntry` being non-null on `verifyUser`

`verifyUser` does not run the enrollment gate (it answers a question the gate asks). It does, however, share the same `enforceEmail` setting that gates `/submit`. Reading it once via `getOrCreateSettings` gives both endpoints the same answer; reading it inside `resolvePairingMode` would race with a concurrent admin toggle.

## Where the changes live

- `src/modules/attendance/attendance.service.ts`
  - New `resolvePairingMode(email, members, enforceEmail)` returns the three-state result.
  - `resolveEnrollment(email)` now returns `{ entry, enforceEmail }` so the submit path can thread the flag without a second settings read.
  - `verifyUser(username, email?)` uses `resolvePairingMode` to filter the `existing` rows whose `memberId` belongs to the same-person set before computing `submittedMemberIds`.
  - `submitAttendance(payload)` does the same, reusing the `enforceEmail` value resolved by the gate.

- `src/modules/attendance/attendance.validation.ts`
  - `verifyUserQuerySchema` gains an optional `email` field, validated by the same `z.email()` chain as the submit schema.

- `src/modules/attendance/attendance.controller.ts`
  - `verifyUser` passes `req.query.email` through to the service. Missing or non-string values pass `null`.

## Failure modes I considered and rejected

- **Re-read the roster entry inside the duplicate helper instead of passing `enforceEmail` through.** Adds a second settings read; would race with admin toggles; would also have to be added to `verifyUser` separately because `verifyUser` doesn't go through `resolveEnrollment`.

- **Make the rule unconditional (drop the `enforceEmail` branch).** Breaks deployments that have the gate off; the system would silently accept duplicates there.

- **Make the rule unconditional on `unpaired` instead of `enforced`.** A supplied but unenrolled email on the enforced path goes through `resolveEnrollment` and throws `NOT_ENROLLED_MESSAGE`; the duplicate read never runs. The `empty` branch only matters on the unenforced path or on `verifyUser`, both of which already pass `enforceEmail`.

- **Compute the link on the write path only, not the read path.** The form's "already submitted" badge would still fire on a handle someone else already submitted under, which is the bug the user reported in the first place.

## Test cases

1. **Paired email + matching handle, prior row today** → duplicate (linked mode, prior row's member matches paired account).
2. **Paired email + matching handle, no prior row** → not duplicate.
3. **Paired email + a DIFFERENT student's handle** → duplicate for the other student's row only when the handle resolves to that student's member; otherwise not duplicate (linked mode empty for the submitting handle).
4. **Unpaired roster entry + handle** → not duplicate (empty mode), even when an unrelated row exists for the same member.
5. **Email supplied but not on the roster, gate on, on `verifyUser`** → not duplicate (empty mode). On `submitAttendance`, gate throws `NOT_ENROLLED_MESSAGE` before the read.
6. **Email not supplied** → prior handle-only behaviour (unrestricted mode).
7. **Gate off** → prior handle-only behaviour (unrestricted mode), regardless of email.

## Migration / config

No schema changes. No config changes. `enforceEmail` already exists.