## Context

Today, the system records a Discord-account pairing for an enrolled address on the first accepted attendance submission and then ignores later submissions that disagree with it. That is described in `roster-discord-linking` as "first-write-wins, never overwritten". It is the right rule for keeping the report clean, but it has two gaps:

1. **A student cannot say "this is not my account".** Once a pairing is recorded, every later submission either records attendance silently under that pairing, or — if it carries a different account — is silently accepted (because the two checks are independent) and recorded under the wrong account.
2. **An administrator cannot correct a known-bad pairing.** The only way to change a pairing today is to deactivate the entire roster entry, which destroys all engagement context.

This change closes both gaps: the student is locked to the recorded pairing (with a clear, distinguishable refusal when they diverge), and an administrator gets a review queue and a single-action endpoint to either re-assign the pairing or dismiss the report.

## Goals / Non-Goals

**Goals:**
- The submission endpoint refuses, with a distinct outcome, any submission whose submitted handle does not match the recorded pairing.
- The submission endpoint accepts an "I cannot enter my real Discord username" flag that converts the mismatch refusal into an accepted submission with a recorded mismatch report, so that a student who genuinely cannot enter the right account is not blocked from recording attendance.
- An administrator-only endpoint lists open reports with filtering, search, and pagination.
- An administrator-only endpoint accepts a single final action (`reassign` or `dismiss`) and applies it in one conditional write, attributing the action to the reviewing administrator.
- The existing "first-write-wins" rule is unchanged for unpaired entries: a first submission still records the pairing, no flag required.

**Non-Goals:**
- Bulk re-assignment: each report is acted on individually. Bulk operations are out of scope for this change.
- Slack/email notifications to the student or to the administrator: the surface is read-and-action only.
- Auto-resolving reports: every action is taken by a human administrator.
- Changing the public verification endpoint to report a per-pairing mismatch state: the spec explicitly forbids it.

## Decisions

### Decision 1 — Mismatch check runs after roster email check, before attendance write

The mismatch check runs after the existing roster email check has confirmed the address is enrolled and held by an active entry that already has a pairing, but before any attendance row is written. This is the only ordering that satisfies two requirements at once: the existing requirement that the student's enrollment is verified before they are accepted, and the new requirement that the student has no opportunity to record attendance against a misattributed pairing.

**Alternative considered**: Run the check after the attendance row is written, inside the same transaction. Rejected because the spec requires the mismatch outcome to refuse the submission outright — no attendance row is recorded for a refused submission.

**Alternative considered**: Run the check only on submissions that arrive with the flag set. Rejected because the spec requires the mismatch outcome to be applied whether or not the flag is set, and the flag only changes what happens after a mismatch is detected.

### Decision 2 — Mismatch report write happens after the attendance transaction, isolated from it

The mismatch report write happens after the attendance transaction has committed, the same way the existing pairing write is performed. A failure to record the report does not change the response and does not roll back attendance. This matches the existing pattern in `roster-discord-linking`: bookkeeping outside the attendance path can never make a student retry.

**Alternative considered**: Write the report inside the same transaction as the attendance row, so that the report is rolled back if attendance is rolled back. Rejected because the existing pairing rule already establishes that the response is the source of truth, not the bookkeeping — and because the spec explicitly requires "report write failure does not affect the submission".

### Decision 3 — Reports are stored in a dedicated table with a per-pairing-per-day uniqueness constraint

A new `discord_pairing_mismatch_reports` table carries one row per open report per pairing per Asia/Dhaka date. The unique constraint on `(roster_entry_id, submission_dhaka_date)` where status = `open` is enforced at the database, not by a read-then-write check, so that two simultaneous flag-set submissions on the same day do not create duplicate rows.

The status column is a string enum (`open`, `reassigned`, `dismissed`) rather than a separate "closed" column. The constraint that at most one `open` row exists per `(roster_entry_id, submission_dhaka_date)` is a partial unique index that allows many closed rows to coexist with the constraint only on `open`.

**Alternative considered**: Allow multiple open reports per day. Rejected because one report per day is enough to surface the issue and avoids duplicating effort on the admin dashboard.

**Alternative considered**: Use a soft-delete column instead of a status column. Rejected because the action is part of the audit trail, not a deletion — the report is the record of an event, and the resolution is part of that record.

### Decision 4 — Reassignment is a single conditional write against the roster entry

When an administrator reassigns, the system rewrites the pairing on the referenced roster entry in a single conditional write that succeeds only while the entry still holds the originally paired account. If the pairing has changed since the report was created (because a reassignment already happened, or because the pairing was somehow reset out-of-band), the write is refused as a conflict and the report's status remains `open`.

This protects against a race where two administrators act on the same report simultaneously, and against a stale dashboard where the report no longer reflects the current pairing.

**Alternative considered**: Read the entry, then write the pairing. Rejected for the same reason the original first-write-wins rule is implemented as a conditional write: a read-then-write check is race-prone in a system where pairings can be acted on by multiple actors.

### Decision 5 — Membership check at reassignment time

The reassignment endpoint re-runs the membership check against the submitted account at the moment of the action, not at the moment of the report. A report opened yesterday against an account that was in a guild then, but is not today, is refused as a non-member. The administrator can dismiss it instead.

**Alternative considered**: Trust the original report's claim. Rejected because a non-member account cannot be a valid pairing and would leave the entry paired to nothing — every subsequent submission would be refused for membership, which is a worse failure mode than the dashboard letting the administrator re-decide.

### Decision 6 — Engagement listing includes the open-report count as an additive field

The open-report count is added to each paired entry's row in the existing engagement listing. Unpaired entries report zero without an additional database read. The count is fetched in a single batched query, indexed on `(roster_entry_id)` filtered by `status = 'open'`, so the listing does not lose its performance characteristics.

**Alternative considered**: A separate endpoint for per-entry report counts. Rejected because the engagement listing already filters by entry and a separate call would force the dashboard to make N+1 requests.

### Decision 7 — The new admin endpoints sit behind the existing administrator-token middleware

The new endpoints are added to the same middleware chain that protects the rest of the roster-admin surface. They inherit the existing audit log entry format, with the action (`reassign` / `dismiss`), the report identifier, the reviewing administrator, and the action time.

**Alternative considered**: Add a separate middleware for "report-action" tokens. Rejected because every other roster-admin endpoint uses the existing middleware and the report action is no more sensitive than a roster correction.

## Risks / Trade-offs

- **Risk**: A student with the right account but a typo in their handle hits the mismatch outcome and submits with the flag, opening a report the administrator has to dismiss. → **Mitigation**: The mismatch outcome message is named clearly, and the dashboard gives the administrator a one-click dismiss.
- **Risk**: An administrator reassigns to an account that is not the student's, shifting the report's resolution onto the wrong person. → **Mitigation**: The report carries the original paired account, the submitting account, and the submitted handle; the administrator can see all three before acting. The reassignment writes the submitted account into the pairing only — not into any other field.
- **Risk**: Reports accumulate without being actioned. → **Mitigation**: The engagement listing shows the open-report count on each paired entry, so the dashboard can surface entries with reports as a kind of attention-needed filter.
- **Risk**: Two simultaneous submissions for the same entry on the same day, both with the flag set, could try to create two open reports. → **Mitigation**: The partial unique index on `(roster_entry_id, submission_dhaka_date)` where `status = 'open'` is the database-level guarantee. The first commits, the second is silently ignored — and the spec is explicit that this is the desired behaviour.
- **Risk**: A misconfigured deployment reads the flag as `true` for every submission, opening reports on every entry. → **Mitigation**: The flag is a JSON boolean; the spec rejects non-boolean values as a validation error. The flag has no default; a missing flag is treated as `false`.
- **Risk**: The new admin endpoints are slower than the existing listing because of the additional join. → **Mitigation**: The open-report count is a single batched, indexed lookup against the `discord_pairing_mismatch_reports` table on `roster_entry_id`, filtered by `status = 'open'`. The engagement listing already batches per-entry data; the new query is appended to the same batch.
- **Trade-off**: A student who has the right account but loses the ability to type it (e.g. lost access to Discord) is now refused with the mismatch outcome. They can still submit by checking the flag, which opens a report and lets the administrator reassign. This is the intended path, but it does mean a student without the flag is fully locked to their pairing.
- **Trade-off**: The mismatch outcome is a fifth distinguishable outcome on the submission path. The spec explicitly forbids adding a fifth outcome for the pairing-step outcome (`pairing write fails` keeps the success response), but the mismatch outcome is a different concern: it is about the student's input, not about bookkeeping. The five outcomes — `validation error`, `address not on roster`, `handle in no guild`, `handle does not match the paired account`, `duplicate for today` — are all distinguishable by the form and each names the field to fix.