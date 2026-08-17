# web-attendance-submission Specification

## Purpose

Defines the public HTTP surface a student uses to record a day's attendance — the first path in the system that accepts input from an unauthenticated caller. It covers how a submitted Discord handle is normalized and format-checked against Discord's official username standard, how that handle is verified live against the synced guild directory, what "already submitted" means for the current Asia/Dhaka calendar date, and which submissions are refused and on what distinguishable grounds. Because students have no login account, the membership check *is* the authorization model: the verification endpoint is an advisory affordance for the form, while the submission endpoint independently re-runs normalization, format validation, and guild-membership verification before any write, so nothing is accepted on the strength of what a client was told earlier. Duplicate refusal rests on the database uniqueness constraint rather than a read-then-write check, and the attendance record plus the member's contact details are written together so neither can survive the other's failure.

## Requirements

### Requirement: Discord handles are normalized before any comparison

The system SHALL normalize a submitted Discord username — trim surrounding whitespace, strip any leading `@`, and lowercase it — before validating its format, looking it up in the member directory, or storing it. No comparison SHALL be made against a raw, un-normalized handle.

#### Scenario: Handle typed with decoration

- **WHEN** a student types ` @Rakib_Dev ` into the Discord username field
- **THEN** it is treated as `rakib_dev`
- **AND** it matches the directory entry for `rakib_dev`

#### Scenario: Handle already normalized

- **WHEN** a student types `rakib_dev`
- **THEN** normalization leaves it unchanged

### Requirement: Handle format is validated against the official Discord standard

The system SHALL reject a handle that does not conform to Discord's official username standard before attempting any directory lookup, and SHALL report the rejection as a format error rather than as "not found".

The accepted form is 2 to 32 characters drawn from lowercase `a-z`, digits `0-9`, underscore, and period, with no two consecutive periods. A leading or trailing underscore or period IS accepted.

#### Scenario: Handle with a leading or trailing separator

- **WHEN** a student enters `itzazad_`, `.rabbil`, or `shahriarratul.`
- **THEN** the handle passes format validation
- **AND** the lookup proceeds normally

#### Scenario: Handle with a forbidden character

- **WHEN** a student enters a handle containing a space, `#`, or `:`
- **THEN** the request is rejected as a format error
- **AND** no directory lookup is performed

#### Scenario: Handle with consecutive periods

- **WHEN** a student enters `rakib..dev`
- **THEN** the request is rejected as a format error

#### Scenario: Handle outside the length bounds

- **WHEN** a student enters a handle of 1 character or of more than 32 characters
- **THEN** the request is rejected as a format error

#### Scenario: Legacy discriminator supplied

- **WHEN** a student enters a handle carrying a discriminator tag such as `rakib#0001`
- **THEN** the request is rejected as a format error

### Requirement: Membership verification reports whether a handle belongs to the guild

The system SHALL expose a public read endpoint that, given a Discord handle, reports whether that handle belongs to a member currently in the guild. The endpoint SHALL require no administrator credentials.

#### Scenario: Handle belongs to a current member

- **WHEN** verification is requested for a handle held by a member currently in the guild
- **THEN** the response reports the handle as verified
- **AND** includes the member's identifier, normalized handle, display name, and avatar URL so the form can show a confirmation badge

#### Scenario: Handle is not in the directory

- **WHEN** verification is requested for a well-formed handle that no directory entry holds
- **THEN** the response reports the handle as not verified
- **AND** carries a message telling the student the handle was not found in the server and that they may need to join it first

#### Scenario: Handle belongs to a departed member

- **WHEN** verification is requested for a handle whose directory entry is flagged as no longer in the guild
- **THEN** the response reports the handle as not verified
- **AND** the departed member's stored record is left untouched

#### Scenario: Verification requires no credentials

- **WHEN** verification is requested with no `Authorization` header
- **THEN** the request is served normally rather than rejected as unauthorized

### Requirement: Verification reports whether today's attendance is already recorded

Along with the membership answer, the system SHALL report whether the verified member already has an attendance record for the current Asia/Dhaka calendar date, and SHALL name that date in the response.

#### Scenario: Member has not submitted today

- **WHEN** a verified member has no attendance record for today's Dhaka date
- **THEN** the response reports that they have not already submitted

#### Scenario: Member has submitted today

- **WHEN** a verified member already has an attendance record for today's Dhaka date
- **THEN** the response reports that they have already submitted
- **AND** the message names the date they submitted for

#### Scenario: Member submitted yesterday only

- **WHEN** a verified member's most recent attendance record is for a previous Dhaka date
- **THEN** the response reports that they have not already submitted today

#### Scenario: Unverified handle carries no submission answer

- **WHEN** a handle is not verified as a current member
- **THEN** the already-submitted answer is reported as false and no member details are disclosed

### Requirement: Attendance submissions are validated field by field

The system SHALL accept an attendance submission carrying exactly a full name, a phone number, an email address, and a Discord username, and SHALL reject the submission if any field is missing or malformed, reporting which fields failed.

#### Scenario: All fields valid

- **WHEN** a submission carries a name of at least 3 characters using English letters and spaces only, a valid Bangladeshi mobile number, a well-formed email, and a valid Discord handle
- **THEN** field validation passes and the submission proceeds to membership verification

#### Scenario: Name too short or containing digits

- **WHEN** the full name is shorter than 3 characters, or contains anything other than English letters and spaces
- **THEN** the submission is rejected as a validation error naming the field

#### Scenario: Name in Bengali script

- **WHEN** a student enters a name using Bengali characters (e.g. `রাকিবুল হাসান`)
- **THEN** the submission is rejected with a message stating that the name must use English letters and spaces only

#### Scenario: Name with only Bengali consonants

- **WHEN** a student enters a name using only Bengali consonant characters (e.g. `রকব`)
- **THEN** the submission is rejected, because non-Latin scripts are not accepted regardless of Unicode category

#### Scenario: Name with digits

- **WHEN** a student enters a name containing digits (e.g. `Rakib 2`)
- **THEN** the submission is rejected as a validation error

#### Scenario: Phone number in an accepted form

- **WHEN** the phone number is given as `01711000000` or as `+8801711000000`
- **THEN** it passes validation

#### Scenario: Phone number malformed

- **WHEN** the phone number does not match an accepted Bangladeshi mobile form
- **THEN** the submission is rejected as a validation error naming the field

#### Scenario: Email malformed

- **WHEN** the email address is not a well-formed address
- **THEN** the submission is rejected as a validation error naming the field

#### Scenario: Unknown fields supplied

- **WHEN** a submission carries fields beyond the four accepted ones
- **THEN** the extra fields are ignored and never written

### Requirement: Submission independently enforces every rule

The system SHALL re-run normalization, format validation, and guild membership verification when a submission is received, regardless of any prior verification call. A submission SHALL NOT be accepted on the strength of the client having called the verification endpoint.

#### Scenario: Submission for a handle never verified

- **WHEN** a submission arrives for a handle that no verification call preceded
- **THEN** the submission is verified server-side and accepted or rejected on that basis alone

#### Scenario: Member leaves between verification and submission

- **WHEN** a handle verifies successfully, the member then leaves the guild, and a submission arrives for that handle
- **THEN** the submission is rejected because the member is no longer in the guild
- **AND** no attendance record is written

#### Scenario: Submission for a handle that does not exist

- **WHEN** a submission arrives for a well-formed handle held by no directory entry
- **THEN** the submission is rejected with the same not-found message the verification endpoint gives
- **AND** no attendance record is written

### Requirement: An accepted submission records the day's attendance

On accepting a submission, the system SHALL write one attendance record owned by the verified member, dated with the current Asia/Dhaka calendar date, retaining the name, phone, and email exactly as submitted.

#### Scenario: Record written for today

- **WHEN** a valid submission from a verified member is accepted
- **THEN** an attendance record is created for that member and today's Dhaka date
- **AND** the response confirms the submission and names the date it was recorded for

#### Scenario: Submitted details are retained verbatim

- **WHEN** a submission is accepted
- **THEN** the name, phone, and email stored on the attendance record are the values the student submitted
- **AND** a later submission with different details does not alter the earlier record

#### Scenario: Submission near the day boundary

- **WHEN** a submission arrives at 23:58 Asia/Dhaka
- **THEN** it is recorded against that day, not the following one
- **AND** the date is the same regardless of the server's own configured timezone

### Requirement: Contact details are carried onto the member directory entry

On accepting a submission, the system SHALL save the submitted phone number and email address onto the member's directory entry, so the dashboard can reach a member who has not submitted today.

#### Scenario: Member with no stored contact details

- **WHEN** a member whose directory entry has no phone or email submits attendance
- **THEN** the submitted phone and email are stored on that entry

#### Scenario: Member updates their details

- **WHEN** a member who previously submitted one email submits again on a later day with a different email
- **THEN** the directory entry carries the newer email
- **AND** the earlier day's attendance record still shows the email submitted that day

#### Scenario: Directory update and attendance write are atomic

- **WHEN** writing the attendance record fails
- **THEN** the directory entry's contact details are left unchanged

### Requirement: A second submission on the same day is refused as a duplicate

The system SHALL refuse a submission from a member who already has an attendance record for the current Asia/Dhaka date, SHALL identify the refusal as a duplicate rather than as an unknown failure, and SHALL name the date in the message. The refusal SHALL rest on the database uniqueness constraint rather than on a prior existence check.

#### Scenario: Member submits twice sequentially

- **WHEN** a member who has already submitted today submits again
- **THEN** the submission is refused as a duplicate
- **AND** the message names today's Dhaka date
- **AND** the existing record is left unchanged

#### Scenario: Two submissions arrive simultaneously

- **WHEN** two submissions for the same member and the same date are processed at the same instant
- **THEN** exactly one attendance record exists afterwards
- **AND** the losing request receives the duplicate refusal, not an unknown error

#### Scenario: Same member on the following day

- **WHEN** a member who submitted yesterday submits today
- **THEN** the submission is accepted as a separate record

### Requirement: Failures are reported distinguishably

The system SHALL give each rejection reason its own outcome, so the form can tell a student what to fix. A format error, an unknown handle, a departed member, a duplicate submission, and a throttled request SHALL NOT be reported as the same failure.

#### Scenario: Format error versus unknown handle

- **WHEN** a malformed handle is submitted and, separately, a well-formed but unknown handle is submitted
- **THEN** the two receive different outcomes with different messages

#### Scenario: Duplicate versus validation failure

- **WHEN** a duplicate submission is refused
- **THEN** its outcome is distinguishable from a field-validation failure

#### Scenario: No internal detail leaked

- **WHEN** any submission is refused
- **THEN** the message describes what the student should do
- **AND** carries no database constraint name, query text, or stack trace outside development
