# Backend Fix — Discord Pairing Mismatch Report Flow

**Date:** 2026-08-20
**Reporter:** Frontend team
**Severity:** Medium (functional, not blocking — but UX bug visible to every student who hits this path)
**Scope:** `POST /api/attendance/submit` (§8.6) and `POST /api/roster/discord-mismatch-reports/:id/action` (§8.6B)

---

## TL;DR

The current `POST /api/attendance/submit` flow returns a generic `201 Attendance submitted successfully` to the student when the body carries `cannotEnterRealDiscordUsername: true`, with **no indication that a Discord pairing-mismatch report was queued for admin review**. The frontend has no way to distinguish a normal attendance submission from a flagged one, so the success card reads identically in both cases.

The student sees:

> ✓ **Attendance recorded**
> Your attendance for 20 Aug 2026 has been recorded.
> Recorded for **Rakib** (hello_morsalin) at 4:08 AM (Dhaka).

…and assumes everything is fine. They have no idea their Discord pairing is still mismatched and that an admin needs to confirm it before they can submit cleanly tomorrow. By tomorrow, when the admin hasn't reviewed the report yet, the student will hit the same 403 on submit — and have no memory of ever opting in.

**The fix:** surface in the response that the report was queued, so the frontend can render a different success state. The OpenSpec delta for §8.6B (and §8.6) should be updated accordingly.

---

## The user-visible problem

### Scenario

1. Student Rakib submits attendance normally every day. His Discord pairing (`hello_morsalin`) was recorded correctly the first time.
2. Rakib changes his Discord username to `rakib_dev` and forgets. Next day he tries to submit.
3. Frontend's live `verify-user` check still passes (the new handle is in a configured guild), so the form is submittable.
4. Backend rejects with 403 + the "Discord username does not match the one already on file" message.
5. Frontend opens the **Discord username mismatch** modal with two options: Cancel, Report & Submit.
6. Rakib clicks **Report & Submit**.
7. Frontend re-submits with `cannotEnterRealDiscordUsername: true`.
8. Backend returns 201 with the same shape as a normal submission.
9. Frontend renders the success card identical to a normal submit (see screenshot).

### What's wrong

The success card tells Rakib nothing about the report. Tomorrow, when he tries to submit again (with the new handle still in place), he'll hit the 403 again. He won't connect "I ticked the box yesterday" → "the report is still open" because **he was never told the report existed**.

For an audit trail, an admin needs to know what happened. For the student, the absence of feedback implies "all good, move on." Both parties are misled.

---

## The contract today (from `API_INTEGRATION.md` §8.6)

> "When set to `true` on a refused submission, the submission is **accepted as today** (attendance is recorded, response shape unchanged), and a discord-pairing-mismatch report is queued against the pairing for an administrator to review. The public response is **byte-for-byte the same** as it would have been without the flag — no paired-account identifier, no count of reports, no record that a report was created."

### Why this needs to change

- The "byte-for-byte the same response" clause was an intentional privacy choice: don't leak account IDs, report counts, or the existence of a report to the student-facing surface.
- **But** the spec also says nothing about telling the student that a *different action* (a report queue) happened in the background. The student cannot interact with the report. They can never see it. So there is no privacy concern in telling them "a report was filed for review."
- The frontend has no signal that distinguishes a normal submit from a report-flagged submit. It can't render a different success state because the wire shape gives it nothing to branch on.

---

## The proposed fix

### Option A (recommended) — distinguish the 201 with a flag in the response

Extend the 201 response body with a top-level boolean — e.g. `reportQueued` — that is `true` exactly when `cannotEnterRealDiscordUsername: true` was honored. **Everything else in the response stays byte-for-byte the same.**

```jsonc
// Normal submission
{
  "success": true,
  "statusCode": 201,
  "message": "Attendance submitted successfully for 2026-08-20",
  "data": { /* …same as today… */ },
  "reportQueued": false,
}

// Submission with cannotEnterRealDiscordUsername: true
{
  "success": true,
  "statusCode": 201,
  "message": "Attendance submitted successfully for 2026-08-20",
  "data": { /* …same as today… */ },
  "reportQueued": true,
}
```

Why this is safe:

- `reportQueued` carries no paired-account identifier, no Discord snowflake, no count. It is the same on/off signal the student already triggered client-side.
- A student cannot use it as an oracle — they already know they ticked the box, so the value isn't new information. The privacy stance from the original spec ("no paired-account identifier, no count of reports, no record that a report was created") is preserved.
- Existing clients that don't read `reportQueued` keep working unchanged.
- New clients (the current frontend) can render a different success card.

The frontend can then render:

> ✓ **Attendance recorded**
> Your attendance for 20 Aug 2026 has been recorded.
> Recorded for **Rakib** (hello_morsalin) at 4:08 AM (Dhaka).
>
> **Note:** Your Discord handle doesn't match the pairing on file for your email. We've notified an admin to review this — once they confirm the new pairing, future submissions will go through normally.

…and tomorrow, after an admin has **reassigned** the report, the next submission goes through cleanly. If the admin **dismissed** the report, the next submission returns the 403 again with the same modal — which is the correct behaviour.

### Option B — return a separate 200/202 with a different body shape

Use a status code other than 201 (e.g. `200 OK` with a body indicating `status: "report-queued"`) and let the frontend map it to a totally different card.

This is more disruptive: it changes the success branch from one to two, requires the OpenSpec delta to mark the new status code, requires the frontend to grow a new `Outcome` variant for it, and contradicts the existing sentence "The public response is byte-for-byte the same as it would have been without the flag."

### Option C — do nothing; rely on the admin's later reassignment

The current flow already works end-to-end at the data level: the report is queued, the admin sees it in `GET /api/roster/discord-mismatch-reports?status=open`, and the admin reassigns or dismisses it. The student just doesn't know.

This is the current behaviour. It's the cheapest to leave alone but it's the bug we're trying to fix.

**Recommendation: Option A.** It's the smallest contract change that fixes the UX, preserves the privacy stance of the original spec, and lets the frontend render an honest success state.

---

## Detailed backend change (Option A)

### `POST /api/attendance/submit`

**Request — unchanged**

```jsonc
{
  "name": "Rakib",
  "phone": "01711000000",
  "email": "rakib@example.com",
  "discordUsername": "rakib_dev",
  "cannotEnterRealDiscordUsername": true,   // already supported, see §8.6
}
```

**Response when `cannotEnterRealDiscordUsername` is `true` AND a report was queued:**

```jsonc
HTTP/1.1 201 Created
Content-Type: application/json

{
  "success": true,
  "statusCode": 201,
  "message": "Attendance submitted successfully for 2026-08-20",
  "data": {
    "attendanceDate": "2026-08-20",
    "submittedAt": "2026-08-20T04:08:00.000Z",
    "member": { /* … unchanged … */ },
    "servers": [ /* … unchanged … */ ],
  },
  "reportQueued": true,
}
```

**Response when `cannotEnterRealDiscordUsername` is absent / `false`:**

```jsonc
HTTP/1.1 201 Created
Content-Type: application/json

{
  "success": true,
  "statusCode": 201,
  "message": "Attendance submitted successfully for 2026-08-20",
  "data": { /* … unchanged … */ },
  "reportQueued": false,
}
```

### When `reportQueued` is `true`

Per the existing spec, the report is queued **only when all three hold**:

1. The submission was otherwise going to fail with 403 (handle-mismatch).
2. `cannotEnterRealDiscordUsername === true` was sent.
3. The entry is paired and the handle differs.

If any of those three is false, the flag is silently treated as `false` (see §8.6: "The flag is ignored (treated as `false`) when the submitted handle resolves to no current guild member — the membership refusal still wins."). In those cases `reportQueued` must be `false` — the absence of a queued report must be reflected honestly.

### When `reportQueued` is `false` but the field was sent

The flag is also rejected as a 400 if it arrives as anything other than a JSON boolean (see §8.6). The new field must not change that behaviour.

### Atomicity

The attendance write and the report insert must be in the **same database transaction**. If the report insert fails (FK violation, disk full, etc.), the attendance write must roll back so the student does not see "Attendance recorded" while no report was filed.

If atomicity is not achievable in the current transaction setup, the alternative is to do the report insert first and abort the submission entirely if it fails — but that means the student gets a 5xx instead of a clean 201. Not great UX, but better than a silently-missing report.

### Backwards compatibility

- `reportQueued` is **additive**. Existing clients ignore unknown fields.
- The 201 status code is preserved.
- The `data` shape is unchanged.
- The `message` field is unchanged.

No client should break.

---

## Frontend changes that follow from this fix

(The frontend PR is already in flight on our side; it lands once the backend returns `reportQueued: true`.)

1. Extend the `Outcome` discriminated union in `app/(public)/attendance-form.tsx`:

   ```ts
   | { kind: "success"; payload: SubmitAttendancePayload; reportQueued: boolean }
   ```

2. Read `reportQueued` from the JSON response and pass it into the outcome state.

3. Render a different success card copy when `reportQueued === true`:

   > ✓ **Attendance recorded**
   > Your attendance for 20 Aug 2026 has been recorded.
   > Recorded for **Rakib** (hello_morsalin) at 4:08 AM (Dhaka).
   >
   > **Pairing mismatch flagged.** Your Discord handle doesn't match the one on file for your email. An admin will review this — once the new pairing is confirmed, your future submissions will go through normally.

4. Update `lib/api/types.ts` so `SubmitAttendancePayload` (or its wrapper) carries the new field.

---

## OpenSpec / documentation updates needed

- **§8.6** (`POST /api/attendance/submit`): extend the 201 example to include `"reportQueued": false`. Add a new paragraph after the existing "Discord-pairing mismatch" section that documents `reportQueued`.
- **§8.6B** (`POST /api/roster/discord-mismatch-reports/:id/action`): no change to the action endpoint itself, but mention in the cross-reference that the report is created via the §8.6 attendance submit path with `cannotEnterRealDiscordUsername: true`, and that the only signal back to the student is `reportQueued: true`.
- **`postman-collection.json`**: add `reportQueued` to the §8.6 success example body so PMs/stakeholders browsing the collection can see the new field.

---

## Test cases to add (backend)

These mirror what the frontend expects to be able to assert. A test failure here is the same bug we're filing:

1. `POST /attendance/submit` with `cannotEnterRealDiscordUsername: true` on a handle-mismatch:
   - Returns 201.
   - `data.attendanceDate` is correct.
   - `data.member.discordUsername` is the **submitted** handle, not the on-file one (matches current behaviour).
   - **NEW ASSERT:** `reportQueued === true`.
   - **NEW ASSERT:** a row exists in `discord_mismatch_reports` with the right `entryId`, `submittingDiscordUsername`, `status: "open"`, `reason: "HANDLE_MISMATCH_PAIRING"`.

2. `POST /attendance/submit` with `cannotEnterRealDiscordUsername: false` (or absent) on a normal submission:
   - Returns 201.
   - `reportQueued === false`.
   - **No** row in `discord_mismatch_reports`.

3. `POST /attendance/submit` with `cannotEnterRealDiscordUsername: true` on a **non-mismatch** submission (e.g. handle matches):
   - Returns 201.
   - `reportQueued === false` (flag is silently ignored per existing spec).
   - **No** row in `discord_mismatch_reports`.

4. `POST /attendance/submit` with `cannotEnterRealDiscordUsername: true` on a member-not-in-guild (404 path):
   - Returns 404 (membership refusal wins).
   - `reportQueued` field is **absent** from the error body — only success carries it.
   - **No** row in `discord_mismatch_reports`.

5. Atomicity test: simulate a failure inserting into `discord_mismatch_reports` after the attendance row is written:
   - Endpoint returns 5xx.
   - **No** attendance row exists (rolled back).
   - **No** report row exists.

---

## What is **not** changing

- The student's Discord pairing on file is **not** updated when `cannotEnterRealDiscordUsername: true` is sent. Only the admin's `reassign` action changes the pairing.
- The student cannot view or interact with the report. They cannot see its id, the admin's notes, or its current status.
- The report is one-shot per `(entry, attendanceDate)`. A second `cannotEnterRealDiscordUsername: true` submission for the same entry on the same Dhaka day, while the first report is still `open`, must be refused (existing behaviour; verify).

---

## Risk assessment

- **Privacy:** none. `reportQueued` carries no identifier or count.
- **Backwards compat:** none. Existing clients ignore unknown fields.
- **DB load:** negligible. One extra `INSERT` per flagged submission, in the same transaction as the attendance row.
- **Failure mode if backend is slow to ship:** the frontend still works correctly today (students see the success card and go on). The only loss is the educational line about "we notified an admin." Once the backend returns `reportQueued`, the frontend update is a one-PR change.

---

## Suggested follow-up PRs

1. **Backend (this fix):** add `reportQueued` to §8.6 success body, atomic report insert.
2. **Backend (related, optional):** consider returning a slightly different `message` when `reportQueued: true` so the toast the student sees also reflects it (today the frontend uses `data.submittedAt` / `data.member.displayName` rather than the message, so this is low-priority).
3. **Frontend:** update the success card copy and the `Outcome` type once (1) lands.
4. **Docs:** update `API_INTEGRATION.md` §8.6 with the new field and §8.6B cross-reference.
5. **Tests:** add the 5 cases above to the backend test suite; the frontend side gets the same coverage from the existing flow test (success card renders the right copy).

---

## Contact

For questions about the frontend change, file the question against this doc with the tag `area:attendance-form`. The frontend PR is ready to ship as soon as the backend PR lands; we will not push it ahead of the contract change.