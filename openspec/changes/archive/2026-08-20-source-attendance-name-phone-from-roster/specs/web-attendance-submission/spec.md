## MODIFIED Requirements

### Requirement: Attendance submissions are validated field by field

The system SHALL accept an attendance submission carrying exactly an email address and a Discord username (plus the optional `cannotEnterRealDiscordUsername` flag), and SHALL reject the submission if any accepted field is missing or malformed, reporting which fields failed. The system SHALL refuse any submission that carries `name` or `phone` as a validation error naming the field, because the system sources those values from the matched roster entry rather than from form input — silently accepting extra keys would let a stale form keep posting fields the API no longer reads.

#### Scenario: Email and Discord username accepted

- **WHEN** a submission carries a well-formed email and a valid Discord handle
- **THEN** field validation passes and the submission proceeds to membership verification

#### Scenario: Email malformed

- **WHEN** the email address is not a well-formed address
- **THEN** the submission is rejected as a validation error naming the field

#### Scenario: Discord handle malformed

- **WHEN** the Discord handle does not match Discord's official username standard
- **THEN** the submission is rejected as a validation error naming the field

#### Scenario: Name field supplied

- **WHEN** a submission carries a `name` field of any value, well-formed or otherwise
- **THEN** the submission is rejected as a validation error naming the field, because the system sources the name from the matched roster entry

#### Scenario: Phone field supplied

- **WHEN** a submission carries a `phone` field of any value, well-formed or otherwise
- **THEN** the submission is rejected as a validation error naming the field, because the system sources the phone from the matched roster entry

#### Scenario: Other unknown fields supplied

- **WHEN** a submission carries fields beyond `email`, `discordUsername`, and `cannotEnterRealDiscordUsername`
- **THEN** the submission is rejected as a validation error naming the first unknown field

### Requirement: An accepted submission records the day's attendance

On accepting a submission, the system SHALL write one attendance record for **each** configured server in which the submitting handle is a current member, each owned by that server's member record, dated with the current Asia/Dhaka calendar date. When roster enforcement is enabled, the attendance row SHALL carry the `name` and `phone` stored on the matched active roster entry and the email exactly as submitted. When roster enforcement is disabled, no roster entry is consulted and the attendance row SHALL carry empty-string `name` and `phone` values alongside the email exactly as submitted. All of those writes SHALL succeed or fail together.

#### Scenario: Record written for today

- **WHEN** a valid submission from a verified member of one server is accepted
- **THEN** an attendance record is created for that member and today's Dhaka date
- **AND** the response confirms the submission and names the date it was recorded for

#### Scenario: Member of two servers submits once

- **WHEN** a valid submission is accepted from a handle that is a current member of two configured servers
- **THEN** one attendance record is created in each server for today's Dhaka date
- **AND** the response names every server the submission was recorded in
- **AND** neither server subsequently reports that member as missing attendance

#### Scenario: The writes are atomic

- **WHEN** one of the per-server attendance writes fails
- **THEN** none of them is committed, so the student is never left recorded in one server and silently missing in the other

#### Scenario: Roster-sourced contact details under enforcement

- **WHEN** enforcement is enabled and a submission is accepted against a roster entry whose stored name and phone number are `Rakib Hasan` and `01711000000`
- **THEN** the name `Rakib Hasan` and the phone `01711000000` are stored on every attendance record written
- **AND** the email stored is the value the student submitted
- **AND** the roster entry is left unchanged
- **AND** a later submission does not alter the earlier day's name or phone (the roster is the source of truth, not the form)

#### Scenario: Empty contact details when enforcement is disabled

- **WHEN** enforcement is disabled and a submission carrying a well-formed email and a valid handle is accepted
- **THEN** the attendance record stores the email exactly as submitted and stores empty strings for `name` and `phone`

#### Scenario: Submission near the day boundary

- **WHEN** a submission arrives at 23:58 Asia/Dhaka
- **THEN** it is recorded against that day, not the following one, in every server it was written to
- **AND** the date is the same regardless of the server's own configured timezone

### Requirement: Contact details are carried onto the member directory entry

On accepting a submission, the system SHALL save the submitted email address onto the member's directory entry **in every server the submission was recorded in**, so the dashboard can reach a member who has not submitted today whichever server it is looking at. The phone number on the directory entry SHALL be updated from the matched roster entry when roster enforcement is enabled, and SHALL be left unchanged when enforcement is disabled.

#### Scenario: Email updates the directory under enforcement

- **WHEN** enforcement is enabled and a member whose directory entry has no email submits attendance
- **THEN** the submitted email is stored on that entry
- **AND** the matched roster entry's stored phone is stored on that entry

#### Scenario: Member of two servers

- **WHEN** a member of two configured servers submits
- **THEN** both servers' directory entries carry the submitted email
- **AND** when enforcement is enabled, both servers' directory entries carry the matched roster entry's stored phone

#### Scenario: Member updates their email on a later day

- **WHEN** a member who previously submitted one email submits again on a later day with a different email
- **THEN** the directory entries carry the newer email
- **AND** the earlier day's attendance records still show the email submitted that day

#### Scenario: Enforcement disabled leaves the directory phone unchanged

- **WHEN** enforcement is disabled and a member submits attendance
- **THEN** the directory entries carry the submitted email
- **AND** the directory entries' existing phone values are left unchanged

#### Scenario: Directory update and attendance write are atomic

- **WHEN** writing any attendance record fails
- **THEN** no directory entry's contact details are changed

### Requirement: The submission accepts an optional "I cannot enter my real Discord username" flag

The system SHALL accept, on the public attendance submission, an optional flag indicating that the student cannot enter their real Discord username. The flag SHALL be carried alongside the two accepted fields (`email` and `discordUsername`) and SHALL be ignored when its value is not a JSON boolean.

The flag SHALL NOT be required. Submissions without it SHALL be processed exactly as they are today. The flag SHALL be rejected only when it is supplied with a non-boolean value.

The flag is consumed only when the submitted address is held by an active roster entry that already holds a Discord account, and the submitted handle is not that account. In that case, the flag changes the outcome from "refused with the mismatch outcome" to "accepted and recorded with a mismatch report", so that a student who genuinely cannot enter the right account can keep submitting attendance while an administrator investigates.

#### Scenario: Flag not supplied

- **WHEN** a submission is accepted without the flag
- **THEN** the submission proceeds through the existing acceptance path unchanged

#### Scenario: Flag supplied with a non-boolean value

- **WHEN** a submission is accepted with the flag set to anything other than a JSON boolean
- **THEN** the submission is refused as a validation error naming the field
- **AND** no attendance record is written

#### Scenario: Flag supplied but the address is unpaired

- **WHEN** an accepted submission carries an enrolled address whose entry holds no Discord account, and the flag is set
- **THEN** the submission is accepted and recorded with the existing first-write-wins pairing
- **AND** no mismatch report is created

#### Scenario: Flag supplied and the handle matches

- **WHEN** an accepted submission carries an enrolled address whose entry is paired with an account, the submitted handle normalizes to that account, and the flag is set
- **THEN** the submission is accepted and recorded with the matching pairing
- **AND** no mismatch report is created

#### Scenario: Flag supplied with a mismatched handle

- **WHEN** an accepted submission carries an enrolled address whose entry is paired with a different account, the submitted handle does not normalize to that account, and the flag is set
- **THEN** the submission is accepted and the day's attendance is written
- **AND** a mismatch report is recorded against the pairing

#### Scenario: Flag supplied with a handle that matches no guild member

- **WHEN** a submission carries the flag and the submitted handle resolves to no current member of any configured guild
- **THEN** the flag is ignored
- **AND** the submission is refused for the membership reason
- **AND** no mismatch report is created

#### Scenario: Flag never reveals a roster detail

- **WHEN** the flag is supplied on an accepted submission
- **THEN** the response body carries no paired-account identifier, no count of open reports, and no record that a report was created

#### Scenario: Flag never changes the distinguishable outcomes

- **WHEN** a submission with the flag is accepted
- **THEN** the response is the normal accepted-submission response, with the same body and status as a submission without the flag

## REMOVED Requirements

### Requirement: The roster never overwrites what was submitted

**Reason**: The form no longer collects name and phone, so there is nothing for the roster to overwrite. The form's name and phone are now sourced from the matched roster entry — a different relationship, captured in the modified "An accepted submission records the day's attendance" requirement under the "Roster-sourced contact details under enforcement" scenario.

**Migration**: None. The behaviour change is encoded in the modified "An accepted submission records the day's attendance" requirement. There is no client-facing migration; the form's submit body shrinks from four fields to two in the same change.