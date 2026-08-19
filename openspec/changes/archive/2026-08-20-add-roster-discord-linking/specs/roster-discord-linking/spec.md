## ADDED Requirements

### Requirement: A roster entry may carry one Discord account

The system SHALL allow an enrolment roster entry to hold the identifier of one Discord **account**, together with the instant that pairing was first recorded. Both SHALL be optional: an entry with no Discord account is a normal, valid entry describing an enrolled person nothing is yet known about on Discord.

The stored identifier SHALL be the Discord account identifier — the same key the daily-status aggregation groups every figure on — and SHALL NOT be a member-directory row identifier. A member-directory row describes a presence in one server, and one person present in two servers has two of them; storing one of those would make the roster point at a membership rather than a person, and would make the pairing disagree with itself depending on which server was consulted.

The pairing instant SHALL be stored separately from the entry's general update timestamp, because an ordinary roster import rewrites the update timestamp on every row it touches and would therefore destroy the answer to "when was this person's account learned".

#### Scenario: Entry with no account

- **WHEN** an entry is created by an import or by an administrator
- **THEN** it is stored with no Discord account and no pairing instant
- **AND** it is a valid, active, enrolled entry

#### Scenario: Entry with an account

- **WHEN** an account is recorded against an entry
- **THEN** the entry holds that account identifier and the instant it was recorded
- **AND** the entry's other fields are unchanged

#### Scenario: The identifier names a person, not a membership

- **WHEN** an entry is linked to a person who is a member of two configured servers
- **THEN** exactly one account identifier is stored
- **AND** the entry carries no server identifier of any kind

### Requirement: At most one enrolled person per Discord account

The system SHALL enforce, through a database uniqueness constraint rather than a read-then-write check, that no two roster entries hold the same Discord account identifier. Entries with no account SHALL be exempt: any number of entries may be unlinked at the same time.

Without the constraint one Discord account could be recorded as two different enrolled people, and every report built on the pairing would count that person's work twice.

#### Scenario: Second entry claims a linked account

- **WHEN** a pairing is attempted between an account and an entry while a different entry already holds that account
- **THEN** the database rejects it as a duplicate
- **AND** neither entry is modified

#### Scenario: Many unlinked entries coexist

- **WHEN** a roster holds thousands of entries that have never been paired
- **THEN** all of them are stored without conflict

### Requirement: A pairing is learned from an accepted attendance submission

The system SHALL record the pairing between an enrolled email address and a Discord account when an attendance submission carrying both is accepted. The submission is the only point at which the two identities are presented together, and it is the point at which both have already been independently checked.

The recording SHALL be attempted for every accepted submission, regardless of whether roster enforcement is currently enabled. Enforcement decides whether an unenrolled address is refused; it has no bearing on whether a matching address should be remembered.

#### Scenario: First submission by an enrolled student

- **WHEN** an attendance submission is accepted carrying an address held by an active, unlinked roster entry
- **THEN** that entry is recorded as paired with the submitting Discord account
- **AND** the pairing instant is recorded

#### Scenario: Enforcement disabled

- **WHEN** an accepted submission carries an enrolled address while roster enforcement is disabled
- **THEN** the pairing is still recorded

#### Scenario: Address not on the roster

- **WHEN** an accepted submission carries an address no active entry holds
- **THEN** no entry is modified
- **AND** no entry is created for that address

#### Scenario: Inactive entry

- **WHEN** an accepted submission carries an address held only by a deactivated entry
- **THEN** no pairing is recorded

### Requirement: The first pairing observed wins and is never overwritten

The system SHALL treat a recorded pairing as final for as long as it stands. A submission that would pair an already-paired entry with a different account, or an already-paired account with a different entry, SHALL leave every stored pairing unchanged.

The claim SHALL be made in a single conditional write that succeeds only while the entry is unpaired, rather than by reading the entry and then writing it. Two students submitting in the same instant would both pass a prior read, and the evening submission window is exactly when that happens.

Overwriting is rejected because the roster stores no Discord identity of its own and therefore cannot tell which of two conflicting observations is the true one. Letting the most recent submission win would allow one student, by submitting under a classmate's enrolled address, to silently move that classmate's pairing onto their own account.

#### Scenario: Repeat submission by the same person

- **WHEN** a student who is already paired submits again on a later day
- **THEN** the stored pairing and its instant are unchanged

#### Scenario: A different account submits under a paired address

- **WHEN** an accepted submission carries an address whose entry is already paired with another account
- **THEN** the stored pairing is unchanged
- **AND** the submission is still accepted and recorded

#### Scenario: A paired account submits under a different enrolled address

- **WHEN** an accepted submission carries an account already paired with one entry and an address held by a different unpaired entry
- **THEN** neither entry is paired
- **AND** the second entry remains unpaired and continues to appear as such

#### Scenario: Two submissions for one address at the same instant

- **WHEN** two accepted submissions carrying the same enrolled address and different accounts commit in the same instant
- **THEN** exactly one pairing is stored and the other is discarded

### Requirement: Recording a pairing can never affect the submission

The system SHALL record the pairing outside the transaction that writes the attendance rows, after that transaction has committed, and SHALL absorb every error the recording raises. A failure to record a pairing SHALL NOT change the response status, the response body, or whether the attendance was written.

The submission endpoint is unauthenticated, is the path every student uses, and already has four distinguishable outcomes. Bookkeeping added to it must not be able to discard a real submission, introduce a fifth outcome, or make a student retry.

#### Scenario: Pairing write fails

- **WHEN** the pairing write raises an error after the attendance transaction has committed
- **THEN** the submission still answers success with its normal body
- **AND** the attendance rows remain committed
- **AND** the failure is logged

#### Scenario: Response shape unchanged

- **WHEN** a submission is accepted and a pairing is recorded
- **THEN** the response body carries no pairing field and no indication that a pairing occurred

#### Scenario: Pairing is not inside the attendance transaction

- **WHEN** the attendance rows are written across every server the handle belongs to
- **THEN** the pairing write is not part of that transaction
- **AND** a pairing failure cannot roll it back

### Requirement: An ambiguous handle is not paired

The system SHALL record a pairing only when every member-directory row resolved from the submitted handle carries the same Discord account. When the resolved rows name more than one account, no pairing SHALL be recorded and the fact SHALL be logged.

A handle can resolve to two different accounts when the directory is stale in one server — a rename observed in one and not yet in the other. Guessing would attach an enrolled person to an account that is not theirs, and a wrong pairing is worse than none: an unpaired entry is visible and gets chased, while a wrong one reads as a healthy, participating student.

#### Scenario: Handle resolves to one account in several servers

- **WHEN** a submitted handle resolves to member rows in two servers carrying the same account
- **THEN** the pairing is recorded with that account

#### Scenario: Handle resolves to two different accounts

- **WHEN** a submitted handle resolves to member rows naming two different accounts
- **THEN** no pairing is recorded
- **AND** the attendance rows are still written to every resolved server
- **AND** the ambiguity is logged

### Requirement: The pairing gates nothing

The system SHALL NOT use a recorded pairing to accept or refuse an attendance submission, to decide guild membership, or to decide roster enforcement. An accepted submission SHALL continue to assert exactly two independent facts — that an enrolled person's address was supplied, and that the submitting account is in a configured server — and SHALL NOT assert that they describe the same person.

The pairing is an observation for reporting. Making it a condition would refuse students who can submit today, on the strength of a pairing that may itself be wrong.

#### Scenario: Submission under a different enrolled address

- **WHEN** a student whose account is paired with one entry submits using a different enrolled address
- **THEN** the submission is accepted exactly as it is today

#### Scenario: Unpaired student submits

- **WHEN** an enrolled student with no recorded pairing submits with a valid handle and an enrolled address
- **THEN** the submission is accepted

#### Scenario: Enforcement decision unchanged

- **WHEN** the roster gate evaluates an address
- **THEN** it consults only whether an active entry holds that address
- **AND** it does not consult any pairing
