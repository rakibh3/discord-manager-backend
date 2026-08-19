# Backend Bug Report — Roster Gate Bypass

## Summary

`GET /api/attendance/verify-email` returns `verified: true` for any well-formed email when the roster gate is OFF, allowing unenrolled addresses to pass verification and submit attendance.

## Endpoint

`GET /api/attendance/verify-email?email=<address>`

## Expected (per `API_INTEGRATION.md` §verify-email & `postman-collection.json`)

When the roster gate is **OFF**, the endpoint should report `emailVerificationRequired: false` and either:

- **Option A (recommended):** Return `verified: false` for all addresses — same shape as the "not enrolled" response. The frontend then renders no badge and gates submit on the gate flag.
- **Option B:** Document explicitly in the response that the gate is off (e.g. `verified: null` or a dedicated `gateOff: true` flag) so the frontend can distinguish "checked, not enrolled" from "no check happened."

## Actual

When `roster_settings.email_verification_required = false`, the endpoint returns:

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Email accepted",
  "data": {
    "verified": true,
    "attendanceDate": "2026-08-20",
    "emailVerificationRequired": false
  }
}
```

for **any** well-formed email — including addresses not on the enrolment roster (e.g. `rakibh-mahdajsh@gmail.com`).

## Impact

- The frontend live badge shows "✅ Email verified" for fake/random emails.
- `POST /api/attendance/submit` accepts those emails (no roster check when gate is off).
- Anyone with a valid email format can submit attendance without ever being enrolled.

## Reproduction

```bash
# Gate is currently OFF in admin settings
curl 'http://localhost:3000/api/attendance/verify-email?email=rakibh-mahdajsh@gmail.com'
# → 200 { "data": { "verified": true, ... } }   ← WRONG

curl 'http://localhost:3000/api/attendance/verify-email?email=ghost-not-on-roster@example.com'
# → 200 { "data": { "verified": true, ... } }   ← WRONG (should be verified:false per roster)
```

## Fix (backend)

In `verify-email` controller, when `roster_settings.email_verification_required = false`:

- Return `verified: false` (not `true`) so the frontend badge correctly reflects "no roster check passed" instead of "this email is enrolled."
- Keep `emailVerificationRequired: false` in the payload so the form knows the gate is disarmed.

The frontend will then render the no-enrolled hint and disable submit (defence-in-depth already in place at `attendance-form.tsx:138-149`).

Alternatively, add a dedicated flag like `data.gateOff: true` so the frontend can render a distinct "roster check disabled by admin" message instead of the generic "not enrolled" hint.

## Frontend already in place

The frontend already branches on `data.verified` only. Once the backend stops returning `verified: true` for unenrolled addresses, the form will correctly block submission with the "❌ এই ইমেইল এনরোলমেন্ট রোস্টারে নেই" hint.