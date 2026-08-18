## MODIFIED Requirements

### Requirement: Membership verification reports whether a handle belongs to the guild

The system SHALL expose a public read endpoint that, given a Discord handle, reports whether that handle belongs to a member currently in **any** configured server, and which servers those are. The endpoint SHALL require no administrator credentials.

#### Scenario: Handle belongs to a current member of one server

- **WHEN** verification is requested for a handle held by a member currently in one configured server
- **THEN** the response reports the handle as verified
- **AND** includes the member's identifier, normalized handle, display name, and avatar URL so the form can show a confirmation badge
- **AND** names the one server the handle is a current member of

#### Scenario: Handle belongs to a current member of both servers

- **WHEN** verification is requested for a handle held by a current member of two configured servers
- **THEN** the response reports the handle as verified once, not twice
- **AND** names both servers

#### Scenario: Handle is not in any directory

- **WHEN** verification is requested for a well-formed handle that no directory entry in any configured server holds
- **THEN** the response reports the handle as not verified
- **AND** carries a message telling the student the handle was not found in the server and that they may need to join it first

#### Scenario: Handle belongs to a departed member

- **WHEN** verification is requested for a handle whose directory entries are all flagged as no longer in their guild
- **THEN** the response reports the handle as not verified
- **AND** the departed members' stored records are left untouched

#### Scenario: Handle departed from one server and present in another

- **WHEN** a handle is departed from one configured server and present in another
- **THEN** the response reports the handle as verified
- **AND** names only the server they are still a member of

#### Scenario: Verification requires no credentials

- **WHEN** verification is requested with no `Authorization` header
- **THEN** the request is served normally rather than rejected as unauthorized

### Requirement: Verification reports whether today's attendance is already recorded

Along with the membership answer, the system SHALL report whether the verified member already has an attendance record for the current Asia/Dhaka calendar date, and SHALL name that date in the response. When the handle is a current member of more than one server, the answer SHALL be reported per server, and the overall answer SHALL be that they have already submitted only when every one of those servers already holds a record.

#### Scenario: Member has not submitted today

- **WHEN** a verified member has no attendance record for today's Dhaka date in any server they belong to
- **THEN** the response reports that they have not already submitted

#### Scenario: Member has submitted today

- **WHEN** a verified member already has an attendance record for today's Dhaka date in every server they belong to
- **THEN** the response reports that they have already submitted
- **AND** the message names the date they submitted for

#### Scenario: Member submitted in one server only

- **WHEN** a verified member belongs to two servers and has today's attendance recorded in one of them
- **THEN** the response reports that they have not already submitted overall
- **AND** reports per server which one already holds a record, so a further submission is not presented as pointless

#### Scenario: Member submitted yesterday only

- **WHEN** a verified member's most recent attendance record is for a previous Dhaka date
- **THEN** the response reports that they have not already submitted today

#### Scenario: Unverified handle carries no submission answer

- **WHEN** a handle is not verified as a current member of any server
- **THEN** the already-submitted answer is reported as false and no member details or server names are disclosed

### Requirement: An accepted submission records the day's attendance

On accepting a submission, the system SHALL write one attendance record for **each** configured server in which the submitting handle is a current member, each owned by that server's member record, dated with the current Asia/Dhaka calendar date, retaining the name, phone, and email exactly as submitted. All of those writes SHALL succeed or fail together.

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

#### Scenario: Submitted details are retained verbatim

- **WHEN** a submission is accepted
- **THEN** the name, phone, and email stored on every attendance record written are the values the student submitted
- **AND** a later submission with different details does not alter the earlier records

#### Scenario: Submission near the day boundary

- **WHEN** a submission arrives at 23:58 Asia/Dhaka
- **THEN** it is recorded against that day, not the following one, in every server it was written to
- **AND** the date is the same regardless of the server's own configured timezone

### Requirement: Contact details are carried onto the member directory entry

On accepting a submission, the system SHALL save the submitted phone number and email address onto the member's directory entry **in every server the submission was recorded in**, so the dashboard can reach a member who has not submitted today whichever server it is looking at.

#### Scenario: Member with no stored contact details

- **WHEN** a member whose directory entry has no phone or email submits attendance
- **THEN** the submitted phone and email are stored on that entry

#### Scenario: Member of two servers

- **WHEN** a member of two configured servers submits
- **THEN** both servers' directory entries carry the submitted phone and email

#### Scenario: Member updates their details

- **WHEN** a member who previously submitted one email submits again on a later day with a different email
- **THEN** the directory entries carry the newer email
- **AND** the earlier day's attendance records still show the email submitted that day

#### Scenario: Directory update and attendance write are atomic

- **WHEN** writing any attendance record fails
- **THEN** no directory entry's contact details are changed

### Requirement: A second submission on the same day is refused as a duplicate

The system SHALL refuse a submission when the submitting handle already has an attendance record for the current Asia/Dhaka date in **every** server it is a current member of, SHALL identify the refusal as a duplicate rather than as an unknown failure, and SHALL name the date in the message. The refusal SHALL rest on the database uniqueness constraint rather than on a prior existence check. When a record exists in some but not all of those servers, the missing records SHALL be written and the submission accepted.

#### Scenario: Member submits twice sequentially

- **WHEN** a member who has already submitted today in every server they belong to submits again
- **THEN** the submission is refused as a duplicate
- **AND** the message names today's Dhaka date
- **AND** the existing records are left unchanged

#### Scenario: Member joined a second server after submitting

- **WHEN** a member who submitted today in one server, and has since joined a second configured server, submits again
- **THEN** the missing record is written for the second server
- **AND** the response is a success naming the servers the submission was recorded in
- **AND** the first server's existing record is left unchanged

#### Scenario: Two submissions arrive simultaneously

- **WHEN** two submissions for the same handle and the same date are processed at the same instant
- **THEN** exactly one attendance record exists per server afterwards
- **AND** the losing request receives the duplicate refusal, not an unknown error

#### Scenario: Same member on the following day

- **WHEN** a member who submitted yesterday submits today
- **THEN** the submission is accepted as a separate record in every server they belong to

## ADDED Requirements

### Requirement: Submission re-resolves the handle across servers and never trusts verification

The system SHALL, on the write path, re-normalize the handle, re-validate its format, and resolve it again to the set of servers in which it is a current member, rather than trusting that verification was called or that its answer is still true. The set resolved at submission time SHALL be the set written to.

#### Scenario: Submission without a prior verification call

- **WHEN** a submission arrives for a handle that was never verified through the read endpoint
- **THEN** the membership check is performed on the write path and the submission is handled on its result

#### Scenario: Membership changed between verify and submit

- **WHEN** a handle was a current member of two servers at verification time and has left one of them by submission time
- **THEN** attendance is recorded only in the server they are still a member of

#### Scenario: Handle left every server between verify and submit

- **WHEN** a handle verified successfully and has left every configured server before submitting
- **THEN** the submission is refused as not found
- **AND** no attendance record is written

#### Scenario: Not-found remains a failure on the write path

- **WHEN** a well-formed handle that is a current member of no configured server submits
- **THEN** the submission is refused as not found, distinctly from a format error
