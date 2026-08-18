## MODIFIED Requirements

### Requirement: Attendance-domain records are owned by a Discord member

The system SHALL make `DiscordMember` the owner of every attendance, daily-update, and reminder-recipient record. Each `DiscordMember` record SHALL belong to exactly one configured Discord server, so the server an attendance-domain record belongs to is determined by its owning member record and is never stored a second time on the record itself. No attendance-domain record SHALL reference the administrator `User` account as its subject.

#### Scenario: Record references a synced member

- **WHEN** an attendance, daily update, or reminder recipient row is written
- **THEN** it carries a foreign key to a row in the synced member directory
- **AND** a write naming a member that does not exist is rejected by the database

#### Scenario: Record inherits its server from its member

- **WHEN** the server of an attendance, daily-update, or reminder-recipient record is determined
- **THEN** it is the server of the member record that owns it
- **AND** no second copy of the server identifier is stored on the record, so the two cannot disagree

#### Scenario: Admin accounts are not subjects

- **WHEN** the attendance domain is queried for who submitted, posted, or was reminded
- **THEN** the answer is drawn from the member directory
- **AND** no administrator login account appears as a subject

#### Scenario: Admin recorded as broadcast author

- **WHEN** an administrator triggers a reminder broadcast
- **THEN** the broadcast record may reference that administrator as its author
- **AND** if that administrator account is later deleted, the broadcast record survives with no author rather than being removed

### Requirement: A member submits at most one attendance per day

The system SHALL enforce, at the database level, that a given member record has at most one attendance record for a given Dhaka calendar date. Because a member record belongs to one server, this SHALL mean at most one attendance per person **per server** per date; a person who belongs to two configured servers SHALL have one attendance record in each.

#### Scenario: First submission stored

- **WHEN** a member has no attendance record for today's Dhaka date and a submission is written
- **THEN** the record is created with the submitter's name, phone, email, the attendance date, and the time of submission

#### Scenario: Second submission rejected

- **WHEN** a write is attempted for a member and date that already has an attendance record
- **THEN** the database rejects it as a duplicate
- **AND** the existing record is left unchanged

#### Scenario: Same person in two servers on the same day

- **WHEN** a Discord account belongs to two configured servers and attendance is written for both of that account's member records on the same date
- **THEN** both writes succeed, because they are different member records
- **AND** each server reports that person as having submitted

#### Scenario: Same member on a different day

- **WHEN** a member who submitted yesterday submits today
- **THEN** the write succeeds as a separate record

#### Scenario: Concurrent duplicate submissions

- **WHEN** two submissions for the same member and date are written at the same instant
- **THEN** exactly one succeeds and the other fails on the uniqueness constraint
- **AND** the failure is distinguishable as a duplicate rather than reported as an unknown error

### Requirement: History survives a member leaving the guild

The system SHALL retain all attendance, daily-update, and reminder history for a member who leaves a Discord server, so past reports stay complete and attributable. Departure SHALL be recorded on the member record of the server that was left, and SHALL leave that account's records in any other configured server untouched.

#### Scenario: Member departs with history

- **WHEN** a member with stored attendance and daily-update records leaves the guild
- **THEN** their member row is flagged as departed and their records remain intact and joinable

#### Scenario: Departure from one server only

- **WHEN** a person who belongs to two configured servers leaves one of them
- **THEN** only that server's member record is flagged as departed
- **AND** their records in the other server, and that server's membership, are unchanged

#### Scenario: Historical report includes departed members

- **WHEN** a report is generated for a past date on which a now-departed member submitted
- **THEN** that member's records appear in the report

#### Scenario: No orphaned records

- **WHEN** the attendance domain is inspected
- **THEN** every record resolves to an existing member row, whether that member is currently in the guild or not

## ADDED Requirements

### Requirement: The member directory is keyed by server and Discord account

The directory SHALL store the configured server each member record belongs to, and SHALL enforce uniqueness of the Discord account and of the normalized handle **within** a server rather than across the whole table.

#### Scenario: Server is part of the record

- **WHEN** a member record is written
- **THEN** it carries the identifier of the configured server it was synced from

#### Scenario: Uniqueness within a server

- **WHEN** a second record is written for a Discord account, or for a normalized handle, that already exists in the same server
- **THEN** the database rejects it as a duplicate

#### Scenario: The same account in two servers

- **WHEN** the same Discord account is written for two different servers
- **THEN** both records are stored, because the pair of server and account is what must be unique

#### Scenario: Existing records are assigned to the server they came from

- **WHEN** the directory is migrated from a single-server model
- **THEN** every existing record is assigned the server it was originally synced from
- **AND** no record is left without a server
