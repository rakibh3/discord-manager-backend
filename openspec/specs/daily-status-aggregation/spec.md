# daily-status-aggregation Specification

## Purpose

Defines how a member's status for a Dhaka calendar date is derived from their attendance and daily-update records — `COMPLETE`, `MISSING_UPDATE`, `MISSING_ATTENDANCE`, or `MISSING_BOTH` — and how that derivation is served to the admin dashboard. It covers the dashboard's summary counts, the reminder target list of members with no daily update, and the filtering, searching, and paging of the per-member result. Aggregation is restricted to members currently in their server unless departed members are explicitly requested, and must run in a fixed, small number of indexed queries rather than one query per member.

A Discord account may hold a member record in more than one configured server. The dashboard therefore carries the per-server view alongside the account-level view: a filtered report narrows who is listed, never whether a listed person has done the work, and a per-server breakdown counts memberships rather than accounts so each server keeps a denominator it can act on.

## Requirements

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

The system SHALL restrict daily status and its summary counts to members currently in their server, unless a caller explicitly asks for departed members to be included. Membership SHALL be evaluated per server: a member currently in one configured server and departed from another SHALL be included for the first and excluded for the second.

#### Scenario: Departed member excluded

- **WHEN** status is computed for today and a member left their server last week
- **THEN** that member does not appear in the result and is not counted as missing

#### Scenario: Departed from one server only

- **WHEN** a Discord account is present in one configured server and departed from another
- **THEN** they appear under the server they are present in and are absent from the other

#### Scenario: Historical view includes past submitters

- **WHEN** status is computed for a past date with departed members explicitly included
- **THEN** members who have since left but submitted on that date appear with their status for that date

#### Scenario: Denominator reflects current members

- **WHEN** the total-member figure behind a completion percentage is produced
- **THEN** it counts members currently in the servers in scope

### Requirement: Summary counts are available without listing members

The system SHALL provide the dashboard's overview figures — total members, attendance submitted, daily update submitted, both completed, missing update only, missing attendance only, and missing both — as an aggregate result that does not require transferring a row per member. It SHALL provide those figures both for the scope requested and broken down per configured server, produced by the same query so the two can never disagree.

#### Scenario: Counts requested for a date

- **WHEN** summary counts are requested for a date
- **THEN** the result carries each of those figures for that date across every configured server in scope

#### Scenario: Per-server breakdown accompanies the totals

- **WHEN** summary counts are requested without naming a server
- **THEN** the result carries the combined figures and a per-server breakdown carrying the same seven figures for each server

#### Scenario: Breakdown sums to the combined figures

- **WHEN** the per-server breakdown and the combined figures are read together
- **THEN** each combined figure equals the sum of that figure across the servers

#### Scenario: Counts requested for one server

- **WHEN** summary counts are requested naming a single configured server
- **THEN** only that server's members are counted

#### Scenario: Counts are internally consistent

- **WHEN** the counts for a date are read
- **THEN** the four status buckets sum to the total member figure used as the denominator, both combined and within each server

#### Scenario: Date with no activity

- **WHEN** counts are requested for a date on which nothing was submitted
- **THEN** every submission figure is zero and every member falls into the missing-both bucket rather than the request failing

### Requirement: Members missing a daily update can be listed for reminders

The system SHALL provide the set of members who have no daily update for a given date, with the Discord snowflake ID needed to DM each of them and the server each member record belongs to. The set SHALL span every configured server unless one is named.

#### Scenario: Reminder target list

- **WHEN** the members missing a daily update for a date are requested
- **THEN** each returned member carries their Discord snowflake user ID, normalized username, display name, and the server their record belongs to

#### Scenario: Target list spans servers

- **WHEN** the target list is built without naming a server
- **THEN** members missing an update in every configured server are included

#### Scenario: A person missing in both servers appears once per server

- **WHEN** a Discord account is a member of two configured servers and has no daily update in either
- **THEN** the target list carries one entry per server
- **AND** the entries carry the same Discord snowflake, so a caller can group them to avoid contacting that person twice

#### Scenario: Departed members are not targeted

- **WHEN** the target list is built
- **THEN** members no longer in the server their record belongs to are excluded, since they cannot be reminded there

#### Scenario: Member with an update is not targeted

- **WHEN** a member posted at least one daily-update message on the date in their server
- **THEN** they are absent from the target list for that server regardless of whether they submitted attendance
- **AND** their record in another server where they posted nothing is still targeted

### Requirement: Status results support the dashboard's filtering and paging

The system SHALL allow the per-member status result to be narrowed by configured server, by status bucket, and by a search term matching a member's name, username, phone, or email, and SHALL allow the result to be returned a page at a time with a total count. The server filter SHALL be optional; omitting it SHALL return every configured server's members.

#### Scenario: Filter by server

- **WHEN** the result is requested naming one configured server
- **THEN** only that server's members are returned
- **AND** the total count reflects that server alone

#### Scenario: No server filter

- **WHEN** no server is named
- **THEN** members of every configured server are returned, each row carrying the server it belongs to

#### Scenario: Unknown server named

- **WHEN** a server that is not configured is named
- **THEN** the request is refused naming the unknown server rather than silently returning every server

#### Scenario: Filter by status

- **WHEN** the result is requested filtered to a single status bucket
- **THEN** only members in that bucket are returned

#### Scenario: Search across identifying fields

- **WHEN** a search term is supplied
- **THEN** members whose display name, Discord username, submitted phone, or submitted email matches are returned
- **AND** matching ignores case

#### Scenario: Server, status and search combine as AND

- **WHEN** a server, a status bucket, and a search term are all supplied
- **THEN** only members matching all three are returned

#### Scenario: Paged result

- **WHEN** a page and page size are supplied
- **THEN** at most that many members are returned
- **AND** the response carries the total number of members matching the filters, so page count can be derived

#### Scenario: Sorting by server

- **WHEN** the result is sorted by server
- **THEN** the sort column is drawn from the closed allowlist of sortable columns rather than assembled from the request

#### Scenario: Export reads the same result

- **WHEN** a filtered result is exported
- **THEN** it is produced from the same filtered query as the on-screen list, including the server filter, so the export matches what was displayed

### Requirement: A single member's daily status can be retrieved with their messages

The system SHALL provide a repository function that, for a given member ID and date, returns that member's status row (using the same derivation as the page query) plus the daily-update messages posted on that date. The row SHALL carry the server the member record belongs to. The status derivation SHALL use the same CASE expression as `getDailyStatusPage` and `getDailyStatusCounts`, so the three can never disagree.

#### Scenario: Member with both attendance and updates

- **WHEN** the single-member status is requested for a member who submitted attendance and posted daily updates on the date
- **THEN** the result carries status `COMPLETE`, the server the member belongs to, and a messages array with each message's id, content, and send timestamp

#### Scenario: Member with no activity

- **WHEN** the single-member status is requested for a member who neither submitted attendance nor posted updates
- **THEN** the result carries status `MISSING_BOTH` and an empty messages array

#### Scenario: Messages are scoped to the member record

- **WHEN** the requested member's Discord account also holds a record in another configured server with its own messages that day
- **THEN** only the messages belonging to the requested member record are returned

#### Scenario: Unknown member

- **WHEN** the single-member status is requested for a member ID that does not exist in the directory
- **THEN** the result is null or empty, so the caller can distinguish "not found" from "found with no activity"

#### Scenario: Messages use messageCreatedAt as the timestamp

- **WHEN** the messages for a member and date are retrieved
- **THEN** each message carries the `messageCreatedAt` timestamp (when the message was sent), not the database insertion timestamp

### Requirement: Every status row carries its server, and cross-server presence is flagged

The system SHALL report, on every per-member status row, the configured server the member record belongs to, and whether that member's Discord account is currently present in more than one configured server. Rows SHALL NOT be merged or de-duplicated across servers.

#### Scenario: Row carries its server

- **WHEN** a status row is returned
- **THEN** it names the configured server the member record belongs to

#### Scenario: Account present in two servers

- **WHEN** a status row is returned for a Discord account currently present in two configured servers
- **THEN** the row indicates that the account is present in more than one server
- **AND** two rows are returned, one per server, each with its own status for that day

#### Scenario: Account present in one server

- **WHEN** a status row is returned for an account present in only that server
- **THEN** the row indicates a single server

#### Scenario: Overlap does not alter the figures

- **WHEN** an account present in two servers is counted
- **THEN** it contributes once to each server's figures and twice to the combined figures, because it owes each server its own daily obligations

### Requirement: The server filter is applied identically to every query in the aggregation

The system SHALL apply the server filter through the same shared query source used by the page query and the counts query, bound as a parameter rather than assembled into SQL text, so a filtered page and its filtered counts can never describe different sets of members.

#### Scenario: Page and counts agree

- **WHEN** a page and its counts are requested with the same server filter
- **THEN** the total reported by the counts matches the total the page reports for that filter

#### Scenario: Filter value is bound, not interpolated

- **WHEN** a server identifier is supplied
- **THEN** it is passed to the database as a bound parameter

#### Scenario: Column dependencies stay documented

- **WHEN** the aggregation's raw queries are changed to carry the server dimension
- **THEN** the list of columns those queries depend on is updated to include the server column, because a rename would otherwise fail only at runtime
