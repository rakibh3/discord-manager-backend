## MODIFIED Requirements

### Requirement: Reminder broadcasts record their outcome per recipient

The system SHALL persist each reminder broadcast as one session record with running delivery counts, and one recipient record per targeted member holding that member's individual delivery outcome. A session SHALL be able to end in a cancelled state, distinct from a failed one, so that a broadcast an administrator deliberately stopped is not recorded the same way as one that stalled.

The session SHALL record the period it covered as a START and an END Dhaka calendar date rather than a single date, together with the criterion, the minimum missed-day count, and the weekday set the run applied. A single-date broadcast SHALL record the same date as both ends. The period SHALL NOT additionally be stored as a third single-date column, because a value derivable from the other two is a copy that can disagree with them.

The dates SHALL remain `YYYY-MM-DD` strings in Asia/Dhaka for the reason every civil date in this domain is a string: a timezone-carrying value can be shifted by a driver onto the wrong day, and these compare and range-scan correctly as strings.

#### Scenario: Broadcast session created

- **WHEN** a reminder broadcast is started for a date or a range
- **THEN** a session record is created holding the start date, the end date, the criterion, the threshold, the weekday set, the message text, the number of members targeted, and a status indicating it has not finished

#### Scenario: Single-date broadcast stored as a one-day period

- **WHEN** a reminder broadcast is started for a single date
- **THEN** the session's start date and end date are both that date

#### Scenario: An overlapping unfinished broadcast is findable

- **WHEN** an unfinished broadcast's period is compared against a proposed new period
- **THEN** the two are identified as overlapping when they share any Dhaka date, using a comparison over the stored start and end dates

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

#### Scenario: Existing broadcasts keep their period

- **WHEN** broadcast sessions written before the period became a range are read
- **THEN** each reports the date it originally covered as both its start and its end
- **AND** no session is left without a period
