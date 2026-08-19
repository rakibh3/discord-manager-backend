## ADDED Requirements

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

#### Scenario: The roster never overwrites what was submitted

- **WHEN** a submission is accepted against a roster entry whose stored name and phone number differ from the submitted ones
- **THEN** the attendance record stores the name, phone number, and email address exactly as the student submitted them
- **AND** the roster entry is left unchanged

### Requirement: The roster check adds no external call to the submission path

The roster check SHALL be a single indexed database read on an exact normalized email address. It SHALL NOT issue a Discord API request, SHALL NOT read a spreadsheet, and SHALL NOT vary with the number of configured servers.

#### Scenario: Submission under enforcement

- **WHEN** enforcement is enabled and a submission is processed
- **THEN** exactly one roster lookup is performed regardless of how many servers the handle belongs to
- **AND** no Discord API request is issued by the roster check

## MODIFIED Requirements

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
