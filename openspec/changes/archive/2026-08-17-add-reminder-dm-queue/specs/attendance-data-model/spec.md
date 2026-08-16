## MODIFIED Requirements

### Requirement: Reminder broadcasts record their outcome per recipient

The system SHALL persist each reminder broadcast as one session record with running delivery counts, and one recipient record per targeted member holding that member's individual delivery outcome. A session SHALL be able to end in a cancelled state, distinct from a failed one, so that a broadcast an administrator deliberately stopped is not recorded the same way as one that stalled.

#### Scenario: Broadcast session created

- **WHEN** a reminder broadcast is started for a date
- **THEN** a session record is created holding that date, the message text, the number of members targeted, and a status indicating it has not finished

#### Scenario: Delivery outcome recorded

- **WHEN** a DM to a targeted member is attempted
- **THEN** that member's recipient record is updated to a terminal outcome of delivered, DM-closed, or failed
- **AND** a failure stores the error detail and a delivery stores the time it was sent

#### Scenario: Closed DMs are identifiable as a group

- **WHEN** a broadcast has finished
- **THEN** the members whose outcome was DM-closed can be listed from the recipient records for the fallback channel announcement

#### Scenario: Retried job does not duplicate a recipient

- **WHEN** a queue job for an already-recorded recipient of a broadcast runs a second time
- **THEN** the database rejects a duplicate recipient row for that broadcast and member pair

#### Scenario: Session deleted

- **WHEN** a broadcast session record is deleted
- **THEN** its recipient records are removed with it

#### Scenario: Broadcast cancelled

- **WHEN** an administrator stops a broadcast that is still running
- **THEN** the session is recorded as cancelled
- **AND** recipients never attempted remain in the not-yet-attempted state rather than being recorded as failed

#### Scenario: Cancelled distinguished from failed

- **WHEN** a broadcast that was cancelled and a broadcast that ended with recipients never attempted are both read
- **THEN** their statuses are distinguishable, because one was a decision and the other is a fault to investigate
