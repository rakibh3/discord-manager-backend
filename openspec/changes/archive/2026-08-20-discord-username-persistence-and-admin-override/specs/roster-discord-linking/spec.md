## MODIFIED Requirements

### Requirement: A submitted handle must match a recorded pairing before it is accepted

The system SHALL refuse, with its own distinguishable outcome separate from field validation, "address not on roster", "handle in no guild", and "duplicate for today", an accepted submission whose submitted handle, normalized, is not the Discord account already recorded against the submitted address, when the address is held by an active roster entry that already holds an account.

The refusal SHALL be applied after normalization and after the existing roster email check has passed, before any attendance row is written.

When the submitted handle is not the recorded pairing, the submission SHALL be refused regardless of roster enforcement state, because the rule is about the student, not about the gate: the student's pairing is set the moment a first accepted submission is recorded, and is what the student must keep submitting under thereafter.

#### Scenario: Submission whose handle does not match the paired account

- **WHEN** an accepted submission carries an enrolled address whose entry is paired with a different account, and the submitted handle is not that account
- **THEN** the submission is refused with the distinguishable "handle does not match the paired account" outcome
- **AND** no attendance record is written
- **AND** the message names only the fact that the handle did not match the paired account
- **AND** carries no paired-account identifier, no roster name, and no count of mismatch reports

#### Scenario: Submission whose handle matches the paired account

- **WHEN** an accepted submission carries an enrolled address whose entry is paired with an account, and the submitted handle normalizes to that account
- **THEN** the submission proceeds through the existing acceptance path unchanged

#### Scenario: Submission under an unpaired enrolled address

- **WHEN** an accepted submission carries an enrolled address whose entry holds no Discord account
- **THEN** the existing first-write-wins recording rule applies
- **AND** no mismatch check runs

#### Scenario: Refusal is distinguishable from every other outcome

- **WHEN** the submission is refused because the handle did not match the paired account
- **THEN** its outcome is distinguishable from field validation, "address not on roster", "handle in no guild", and "duplicate for today"

#### Scenario: Membership check still gates the mismatch outcome

- **WHEN** a submission carries an enrolled address whose entry is paired with a different account, but the submitted handle resolves to no current member of any configured guild
- **THEN** the submission is refused for the membership reason, not for the mismatch reason
- **AND** no mismatch report is created

## REMOVED Requirements

### Requirement: A different account submits under a paired address

**Reason**: The original rule allowed a second account to submit under a paired address while leaving the stored pairing unchanged; this is now superseded by the "submitted handle must match a recorded pairing" rule, which refuses the submission outright instead of silently accepting it.

**Migration**: Submissions whose handle does not match the paired account are now refused with the "handle does not match the paired account" outcome. Students who cannot enter their real handle submit with the "I cannot enter my real Discord username" flag, which records a mismatch report instead of writing attendance under a misattributed pairing.
