## MODIFIED Requirements

### Requirement: The submission accepts an optional "I cannot enter my real Discord username" flag

The system SHALL accept, on the public attendance submission, an optional flag indicating that the student cannot enter their real Discord username. The flag SHALL be carried alongside the four accepted fields and SHALL be ignored when its value is not a JSON boolean.

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