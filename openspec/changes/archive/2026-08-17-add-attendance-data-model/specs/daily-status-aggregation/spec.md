## ADDED Requirements

### Requirement: Each member has a derived daily status

The system SHALL derive, for a given Dhaka calendar date, a status for each member from whether that member has an attendance record and whether that member has at least one daily-update record for that date.

#### Scenario: Both submitted

- **WHEN** a member has an attendance record and at least one daily update for the date
- **THEN** their status is `COMPLETE`

#### Scenario: Attendance only

- **WHEN** a member has an attendance record but no daily update for the date
- **THEN** their status is `MISSING_UPDATE`

#### Scenario: Daily update only

- **WHEN** a member has a daily update but no attendance record for the date
- **THEN** their status is `MISSING_ATTENDANCE`

#### Scenario: Neither submitted

- **WHEN** a member has neither an attendance record nor a daily update for the date
- **THEN** their status is `MISSING_BOTH`

#### Scenario: Multiple updates do not change the status

- **WHEN** a member posted several daily-update messages on the date
- **THEN** they appear exactly once in the result with a single status

### Requirement: Status is computed in a bounded number of queries

The system SHALL compute daily status for the whole member directory without issuing per-member queries. The number of database round trips SHALL NOT grow with the number of members.

#### Scenario: Full directory aggregation

- **WHEN** status is computed for roughly 5,000 members
- **THEN** it is served by a fixed, small number of queries rather than one query per member

#### Scenario: Indexed lookup by date

- **WHEN** the aggregation filters attendance and daily-update records by date
- **THEN** it uses an index on the date column rather than scanning every row in those tables

### Requirement: Only current members are counted by default

The system SHALL restrict daily status and its summary counts to members currently in the guild, unless a caller explicitly asks for departed members to be included.

#### Scenario: Departed member excluded

- **WHEN** status is computed for today and a member left the guild last week
- **THEN** that member does not appear in the result and is not counted as missing

#### Scenario: Historical view includes past submitters

- **WHEN** status is computed for a past date with departed members explicitly included
- **THEN** members who have since left but submitted on that date appear with their status for that date

#### Scenario: Denominator reflects current members

- **WHEN** the total-member figure behind a completion percentage is produced
- **THEN** it counts members currently in the guild

### Requirement: Summary counts are available without listing members

The system SHALL provide the dashboard's overview figures — total members, attendance submitted, daily update submitted, both completed, missing update only, missing attendance only, and missing both — as an aggregate result that does not require transferring a row per member.

#### Scenario: Counts requested for a date

- **WHEN** summary counts are requested for a date
- **THEN** the result carries each of those figures for that date

#### Scenario: Counts are internally consistent

- **WHEN** the counts for a date are read
- **THEN** the four status buckets sum to the total member figure used as the denominator

#### Scenario: Date with no activity

- **WHEN** counts are requested for a date on which nothing was submitted
- **THEN** every submission figure is zero and every member falls into the missing-both bucket rather than the request failing

### Requirement: Members missing a daily update can be listed for reminders

The system SHALL provide the set of members who have no daily update for a given date, with the Discord snowflake ID needed to DM each of them.

#### Scenario: Reminder target list

- **WHEN** the members missing a daily update for a date are requested
- **THEN** each returned member carries their Discord snowflake user ID, normalized username, and display name

#### Scenario: Departed members are not targeted

- **WHEN** the target list is built
- **THEN** members no longer in the guild are excluded, since they cannot be reminded

#### Scenario: Member with an update is not targeted

- **WHEN** a member posted at least one daily-update message on the date
- **THEN** they are absent from the target list regardless of whether they submitted attendance

### Requirement: Status results support the dashboard's filtering and paging

The system SHALL allow the per-member status result to be narrowed by status bucket and by a search term matching a member's name, username, phone, or email, and SHALL allow the result to be returned a page at a time with a total count.

#### Scenario: Filter by status

- **WHEN** the result is requested filtered to a single status bucket
- **THEN** only members in that bucket are returned

#### Scenario: Search across identifying fields

- **WHEN** a search term is supplied
- **THEN** members whose display name, Discord username, submitted phone, or submitted email matches are returned
- **AND** matching ignores case

#### Scenario: Paged result

- **WHEN** a page and page size are supplied
- **THEN** at most that many members are returned
- **AND** the response carries the total number of members matching the filters, so page count can be derived

#### Scenario: Export reads the same result

- **WHEN** a filtered result is exported
- **THEN** it is produced from the same filtered query as the on-screen list, so the export matches what was displayed
