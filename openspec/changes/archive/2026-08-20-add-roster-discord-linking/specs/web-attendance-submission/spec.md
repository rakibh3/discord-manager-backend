## ADDED Requirements

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

- **WHEN** an accepted submission carries an address no active entry holds
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
