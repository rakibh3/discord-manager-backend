# web-attendance-submission delta

## ADDED Requirements

### Requirement: The duplicate-detection read is pairing-aware

When roster enforcement is enabled AND the submitted email is held by an active roster entry that is paired with a Discord account, the `alreadySubmitted` answer on `verifyUser` and the duplicate check on `submitAttendance` SHALL restrict prior-row attribution to attendance rows whose `member_id` belongs to the same Discord account the entry is paired with. Attendance rows for unrelated Discord accounts that happen to share the same handle SHALL NOT count as a duplicate for this email+handle combination.

#### Scenario: Paired email and matching handle with a prior row

- **WHEN** enforcement is enabled, the email is on the roster, the entry is paired with a Discord account, the submitted handle resolves to that account, and a prior row exists for the same member on today's Dhaka date
- **THEN** the verification answer reports `alreadySubmitted: true`
- **AND** the submit endpoint refuses the submission as a duplicate

#### Scenario: Paired email and matching handle with no prior row

- **WHEN** enforcement is enabled, the email is on the roster, the entry is paired with a Discord account, the submitted handle resolves to that account, and no prior row exists for that member today
- **THEN** the verification answer reports `alreadySubmitted: false`
- **AND** the submit endpoint accepts the submission

#### Scenario: Paired email and a different student's handle

- **WHEN** enforcement is enabled, the email is on the roster, the entry is paired with one Discord account, and the submitted handle resolves to a different Discord account
- **THEN** the verification answer reports `alreadySubmitted: false` for that handle
- **AND** the submit endpoint does not refuse the submission on the duplicate path — the pairing-mismatch flow remains the gate for this case

#### Scenario: Unpaired roster entry with a prior row

- **WHEN** enforcement is enabled, the email is on the roster, the entry holds no Discord account, and a prior row exists for the same member on today's Dhaka date
- **THEN** the verification answer reports `alreadySubmitted: false`
- **AND** the submit endpoint does not refuse the submission on the duplicate path

#### Scenario: Email not on the roster

- **WHEN** enforcement is enabled, the email is supplied, and no active roster entry holds it
- **THEN** the verification answer reports `alreadySubmitted: false`
- **AND** the submit endpoint, which runs the gate before the duplicate read, refuses the submission as not enrolled

#### Scenario: Roster enforcement disabled

- **WHEN** enforcement is disabled and the email is supplied
- **THEN** the duplicate read falls back to the prior handle-only behaviour
- **AND** any prior row for the resolved members counts as a duplicate

#### Scenario: Email absent on verify-user

- **WHEN** `verifyUser` is called without an `email` query parameter
- **THEN** the duplicate read falls back to the prior handle-only behaviour
- **AND** any prior row for the resolved members counts as a duplicate

## MODIFIED Requirements

### Requirement: `verifyUser` accepts an optional `email` parameter

The `GET /api/attendance/verify-user` endpoint SHALL accept an optional `email` query parameter. When the parameter is supplied, the service uses it to apply the pairing-aware duplicate rule defined above. When the parameter is absent or empty, the endpoint behaves as before. The endpoint SHALL reject a malformed email with a 400 naming the field, and SHALL otherwise accept a well-formed email whose value is not on the roster.

The response shape is unchanged. The new parameter is additive — callers that omit it see the prior behaviour.

#### Scenario: Email supplied and well-formed

- **WHEN** `verifyUser` is called with a well-formed email query parameter
- **THEN** the request is served normally
- **AND** the duplicate read uses the supplied email under the pairing-aware rule

#### Scenario: Email supplied and malformed

- **WHEN** `verifyUser` is called with an email query parameter that is not a well-formed address
- **THEN** the request is refused as a validation error naming the field

#### Scenario: Email not supplied

- **WHEN** `verifyUser` is called without an email query parameter
- **THEN** the request is served normally
- **AND** the duplicate read falls back to the prior handle-only behaviour
