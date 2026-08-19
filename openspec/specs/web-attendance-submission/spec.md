# web-attendance-submission Specification

## Purpose

Defines the public HTTP surface a student uses to record a day's attendance — the first path in the system that accepts input from an unauthenticated caller. It covers how a submitted Discord handle is normalized and format-checked against Discord's official username standard, how that handle is verified live against the synced guild directory across every configured server, what "already submitted" means for the current Asia/Dhaka calendar date, and which submissions are refused and on what distinguishable grounds.

A Discord account may be a current member of more than one configured server, and the student only submits once. The system therefore writes attendance for every server the submitting account is in, atomically, and credits the day to the account everywhere — one person submits once, the day is recorded in every server the account belongs to. Because students have no login account, the membership check *is* the authorization model: the verification endpoint is an advisory affordance for the form, while the submission endpoint independently re-runs normalization, format validation, and per-server membership verification before any write, so nothing is accepted on the strength of what a client was told earlier. Duplicate refusal rests on the database uniqueness constraint rather than a read-then-write check, and the attendance record plus the member's contact details are written together so neither can survive the other's failure.

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

### Requirement: Submission independently enforces every rule

The system SHALL re-run normalization, format validation, guild membership verification, and — when roster enforcement is enabled — the roster email check when a submission is received, regardless of any prior verification call. A submission SHALL NOT be accepted on the strength of the client having called the verification endpoint.

Every check SHALL be evaluated against the state at the moment of the submission, not the state an earlier call observed. Membership can end and a roster entry can be deactivated in the interval while the student fills the form.

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

#### Scenario: Roster entry deactivated between page load and submission

- **WHEN** enforcement is enabled and a roster entry is deactivated after the student opened the form but before the submission arrives
- **THEN** the submission is rejected as not enrolled
- **AND** no attendance record is written

#### Scenario: Enforcement enabled between page load and submission

- **WHEN** enforcement is turned on after the student opened the form but before the submission arrives
- **THEN** the submission is subject to the roster check

### Requirement: An accepted submission requires an enrolled email address

When roster enforcement is enabled, the system SHALL accept a submission only if the submitted email address, normalized, is held by an active roster entry. A submission whose address is not on the roster SHALL be refused and no attendance record SHALL be written, in any server.

The roster check and the guild-membership check are INDEPENDENT of one another. The roster entry is not required to describe the same person as the Discord account: the system SHALL NOT require the roster to know anything about Discord handles, and SHALL NOT require the submitted handle to be associated with the matched entry. What is being asserted is that an enrolled person's address was given AND that the submitting account is in a configured server — two facts, checked separately, both required.

When roster enforcement is disabled, submission SHALL behave exactly as it did before the roster existed: the email address is validated for format, stored as given, and not compared against anything.

#### Scenario: Enrolled address and a member handle

- **WHEN** enforcement is enabled and a submission carries an email address held by an active roster entry and a handle belonging to a current member of a configured server
- **THEN** the submission is accepted and today's attendance is recorded

#### Scenario: Address not on the roster

- **WHEN** enforcement is enabled and a submission carries a well-formed address that no active roster entry holds
- **THEN** the submission is refused
- **AND** no attendance record is written in any server

#### Scenario: Enrolled address but a handle in no server

- **WHEN** enforcement is enabled and a submission carries an enrolled address and a handle that belongs to no current member of any configured server
- **THEN** the submission is refused for the membership reason
- **AND** no attendance record is written

#### Scenario: The two checks are not paired

- **WHEN** enforcement is enabled and a submission carries one enrolled person's email address together with a different person's Discord handle, that handle belonging to a current member
- **THEN** the submission is accepted, because the two checks are independent by design

#### Scenario: Address on a deactivated entry

- **WHEN** enforcement is enabled and a submission carries an address held only by a deactivated roster entry
- **THEN** the submission is refused as not enrolled

#### Scenario: Address differing in case or padded with spaces

- **WHEN** enforcement is enabled and a submission carries ` Rakib@Example.COM ` while the roster holds `rakib@example.com`
- **THEN** the address matches and the submission proceeds

#### Scenario: Enforcement disabled

- **WHEN** enforcement is disabled and a submission carries an address that no roster entry holds
- **THEN** the roster is not consulted and the submission is accepted on the membership check alone

### Requirement: The roster check adds no external call to the submission path

The roster check SHALL be a single indexed database read on an exact normalized email address. It SHALL NOT issue a Discord API request, SHALL NOT read a spreadsheet, and SHALL NOT vary with the number of configured servers.

#### Scenario: Submission under enforcement

- **WHEN** enforcement is enabled and a submission is processed
- **THEN** exactly one roster lookup is performed regardless of how many servers the handle belongs to
- **AND** no Discord API request is issued by the roster check

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

### Requirement: Failures are reported distinguishably

The system SHALL give each rejection reason its own outcome, so the form can tell a student what to fix. A format error, an unknown handle, a departed member, an unenrolled email address, a duplicate submission, and a throttled request SHALL NOT be reported as the same failure.

A refusal on the roster check SHALL be reported as its own outcome, distinct from the outcome given for a handle that belongs to no server, so the form can point the student at the field that is actually wrong. It SHALL name only the fact that the address was not recognized. It SHALL NOT report whose entry an address belongs to, SHALL NOT report a similar or suggested address, and SHALL NOT reveal whether an unmatched address exists on a deactivated entry — a refusal is the same answer for an address that was never enrolled and for one that was removed.

#### Scenario: Format error versus unknown handle

- **WHEN** a malformed handle is submitted and, separately, a well-formed but unknown handle is submitted
- **THEN** the two receive different outcomes with different messages

#### Scenario: Unenrolled address versus unknown handle

- **WHEN** a submission is refused because the address is not enrolled and, separately, a submission is refused because the handle is in no server
- **THEN** the two receive different outcomes with different messages, so the form can indicate which field to correct

#### Scenario: Duplicate versus validation failure

- **WHEN** a duplicate submission is refused
- **THEN** its outcome is distinguishable from a field-validation failure

#### Scenario: Never enrolled and removed are indistinguishable

- **WHEN** a submission carries an address that was never on the roster and, separately, one held by a deactivated entry
- **THEN** both receive the same refusal, revealing nothing about who was previously enrolled

#### Scenario: No roster detail leaked

- **WHEN** a submission is refused on the roster check
- **THEN** the message says only that the address was not recognized
- **AND** carries no name, no phone number, no suggested address, and no count of roster entries

#### Scenario: No internal detail leaked

- **WHEN** any submission is refused
- **THEN** the message describes what the student should do
- **AND** carries no database constraint name, query text, or stack trace outside development

### Requirement: An accepted submission records the email-to-account pairing

The system SHALL record, after an accepted submission has written its attendance rows, the pairing between the submitted email address and the submitting Discord account, when the address is held by an active roster entry that holds no account yet.

The submission is the only request in the system carrying both an enrolled address and a Discord handle, and by the time the attendance is written both have already been independently checked. Discarding that pairing is what leaves an enrolled person who has never submitted indistinguishable from one who never enrolled on Discord at all.

The recording SHALL be attempted whether or not roster enforcement is enabled, and SHALL take no external call — no Discord API request, no additional round trip beyond a single indexed write against a local table.

#### Scenario: First accepted submission by an enrolled student

- **WHEN** a submission carrying an enrolled address and a valid handle is accepted
- **THEN** the roster entry holding that address is recorded as paired with the submitting account

#### Scenario: Enforcement disabled

- **WHEN** an accepted submission carries an enrolled address while enforcement is disabled
- **THEN** the pairing is still recorded

#### Scenario: Address is not on the roster

- **WHEN** a submission carries an address no active entry holds
- **THEN** no roster entry is created or modified

#### Scenario: No external call added

- **WHEN** a submission is accepted and the pairing is recorded
- **THEN** no Discord API call is made on account of the pairing

### Requirement: The pairing step cannot change the outcome of a submission

The system SHALL perform the pairing write outside the transaction that records attendance, after that transaction commits, and SHALL absorb every error it raises. The response status, the response body, and whether the attendance was written SHALL be identical whether the pairing succeeded, was declined as a conflict, or failed outright.

The four distinguishable submission outcomes — a field error, an address not on the roster, a handle in no server, and a duplicate for the day — SHALL remain exactly four. The form uses the difference between them to tell a student what to fix, and a fifth outcome caused by bookkeeping would name a problem the student cannot act on.

#### Scenario: Pairing write fails

- **WHEN** the pairing write raises an error after attendance has been committed
- **THEN** the response is the normal success response
- **AND** the attendance rows remain committed

#### Scenario: Pairing declined as a conflict

- **WHEN** the submitting account is already paired with a different entry
- **THEN** the submission is still accepted and answers success

#### Scenario: Response body unchanged

- **WHEN** a submission is accepted
- **THEN** the response body carries the same fields it carried before pairing existed

#### Scenario: Failure outcomes unchanged

- **WHEN** submissions are made that fail validation, the roster check, the membership check, and the duplicate check
- **THEN** they answer 400, 403, 404, and 409 respectively, as before

### Requirement: A recorded pairing does not tighten the submission checks

The system SHALL continue to accept a submission on exactly two independent conditions — that an active roster entry holds the submitted address when enforcement is enabled, and that the submitted handle resolves to a current member of at least one configured server. It SHALL NOT additionally require that the entry and the account are already paired with each other, or that they are not paired with anyone else.

What an accepted submission asserts is unchanged: an enrolled person's address was supplied, and the submitting account is in a configured server. It still does not assert that the two describe the same person, and the pairing must not be read as though it did.

#### Scenario: Submitting under another enrolled address

- **WHEN** a student whose account is paired with one entry submits using a different enrolled address
- **THEN** the submission is accepted

#### Scenario: Unpaired student submits

- **WHEN** an enrolled student with no pairing submits with a valid handle and an enrolled address
- **THEN** the submission is accepted

#### Scenario: Roster gate consults only the address

- **WHEN** the roster gate evaluates a submission
- **THEN** it consults only whether an active entry holds the submitted address

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
