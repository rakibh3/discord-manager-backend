## ADDED Requirements

### Requirement: Attendance-domain records are owned by a Discord member

The system SHALL make `DiscordMember` the owner of every attendance, daily-update, and reminder-recipient record. No attendance-domain record SHALL reference the administrator `User` account as its subject.

#### Scenario: Record references a synced member

- **WHEN** an attendance, daily update, or reminder recipient row is written
- **THEN** it carries a foreign key to a row in the synced member directory
- **AND** a write naming a member that does not exist is rejected by the database

#### Scenario: Admin accounts are not subjects

- **WHEN** the attendance domain is queried for who submitted, posted, or was reminded
- **THEN** the answer is drawn from the member directory
- **AND** no administrator login account appears as a subject

#### Scenario: Admin recorded as broadcast author

- **WHEN** an administrator triggers a reminder broadcast
- **THEN** the broadcast record may reference that administrator as its author
- **AND** if that administrator account is later deleted, the broadcast record survives with no author rather than being removed

### Requirement: A member submits at most one attendance per day

The system SHALL enforce, at the database level, that a given member has at most one attendance record for a given Dhaka calendar date.

#### Scenario: First submission stored

- **WHEN** a member has no attendance record for today's Dhaka date and a submission is written
- **THEN** the record is created with the submitter's name, phone, email, the attendance date, and the time of submission

#### Scenario: Second submission rejected

- **WHEN** a write is attempted for a member and date that already has an attendance record
- **THEN** the database rejects it as a duplicate
- **AND** the existing record is left unchanged

#### Scenario: Same member on a different day

- **WHEN** a member who submitted yesterday submits today
- **THEN** the write succeeds as a separate record

#### Scenario: Concurrent duplicate submissions

- **WHEN** two submissions for the same member and date are written at the same instant
- **THEN** exactly one succeeds and the other fails on the uniqueness constraint
- **AND** the failure is distinguishable as a duplicate rather than reported as an unknown error

### Requirement: Attendance retains the details as submitted

The system SHALL store the name, phone number, and email exactly as given on the form alongside each attendance record, rather than resolving them from the member directory at read time.

#### Scenario: Submitted details preserved

- **WHEN** a member submits attendance and later changes their phone number on a subsequent day's submission
- **THEN** the earlier record still shows the phone number given at that time

#### Scenario: Record readable without the directory

- **WHEN** an attendance record is read for a report
- **THEN** the submitted name, phone, and email are available from the record itself without joining the member directory

### Requirement: Daily-update messages are stored idempotently

The system SHALL store each ingested `#daily-update` message once. The Discord message ID SHALL be unique across all stored daily updates.

#### Scenario: Message stored on first ingestion

- **WHEN** a message from the daily-update channel is ingested
- **THEN** a record is created holding the member, the Discord message ID, the channel ID, the message content, the Dhaka date the message was sent on, and the time it was sent

#### Scenario: Same message ingested twice

- **WHEN** the same Discord message ID is ingested again, for example after a bot reconnect replays an event
- **THEN** no second record is created

#### Scenario: Multiple messages in one day

- **WHEN** a member posts several messages in the daily-update channel on the same day
- **THEN** every message is stored as its own record
- **AND** the member counts as having submitted a daily update for that day exactly once

#### Scenario: Long message content

- **WHEN** a message longer than a few hundred characters is ingested
- **THEN** the full content is stored without truncation

### Requirement: Reminder broadcasts record their outcome per recipient

The system SHALL persist each reminder broadcast as one session record with running delivery counts, and one recipient record per targeted member holding that member's individual delivery outcome.

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

### Requirement: History survives a member leaving the guild

The system SHALL retain all attendance, daily-update, and reminder history for a member who leaves the Discord server, so past reports stay complete and attributable.

#### Scenario: Member departs with history

- **WHEN** a member with stored attendance and daily-update records leaves the guild
- **THEN** their member row is flagged as departed and their records remain intact and joinable

#### Scenario: Historical report includes departed members

- **WHEN** a report is generated for a past date on which a now-departed member submitted
- **THEN** that member's records appear in the report

#### Scenario: No orphaned records

- **WHEN** the attendance domain is inspected
- **THEN** every record resolves to an existing member row, whether that member is currently in the guild or not

### Requirement: Attendance-domain writes are safe to retry

The system SHALL express duplicate-prevention through database constraints rather than through read-then-write checks in application code, so concurrent or retried writes cannot produce duplicates.

#### Scenario: Constraint is the enforcement point

- **WHEN** duplicate prevention for attendance, daily updates, or reminder recipients is exercised
- **THEN** the guarantee holds even if the application performed no prior existence check

#### Scenario: Duplicate surfaces as a known error

- **WHEN** a write violates one of these constraints
- **THEN** the failure is reported as a duplicate through the existing central error handling rather than as an unhandled exception
