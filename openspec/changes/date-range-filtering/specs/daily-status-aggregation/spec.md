## ADDED Requirements

### Requirement: Status can be aggregated over a range of dates

The system SHALL aggregate per-person status over an inclusive range of Dhaka calendar dates in addition to a single date. A range aggregation SHALL produce ONE row per Discord ACCOUNT, as the single-date aggregation does, and SHALL credit work done in any configured server to that account everywhere — a range does not change what a person owes, only how many days are being asked about.

For each account the aggregation SHALL report the number of days in the range that count, and the number of those days on which the account submitted attendance, posted a daily update, did both, did neither, and was not fully complete.

#### Scenario: Per-day counts for an account

- **WHEN** status is aggregated over a three-day range for an account that submitted attendance on all three days and posted a daily update on two of them
- **THEN** the account appears as one row
- **AND** its attendance-day count is 3, its update-day count is 2, its complete-day count is 2, its incomplete-day count is 1, and its missed-both-day count is 0

#### Scenario: An account with no activity in the range

- **WHEN** status is aggregated over a range for an account that submitted nothing and posted nothing
- **THEN** the account still appears as one row
- **AND** its missed-both-day count equals the number of days in the range
- **AND** it is not omitted from the result for having no matching records

#### Scenario: Credit still spans servers over a range

- **WHEN** an account is a current member of two configured servers and posted its daily update in only one of them on a given day
- **THEN** that day counts as an update day for the account
- **AND** narrowing the aggregation to the other server changes which accounts are listed but does not reduce that account's update-day count

#### Scenario: Multiple submissions on one day count once

- **WHEN** an account posted five daily-update messages on a single day in the range
- **THEN** that day contributes one to the update-day count, not five

### Requirement: A range aggregation counts only the days the administrator selected

The system SHALL accept an optional set of weekdays, expressed in the same 0-is-Sunday numbering the channel schedule uses, that restricts which days inside a range are counted. When the set is omitted, every calendar day in the range SHALL count. The number of counted days SHALL be reported alongside every figure derived from it, because a count without its denominator cannot be checked.

The counted-day set SHALL be derived from the request, never from the stored channel schedule, because that schedule is a single mutable row with no history and would make a historical report change when an administrator edits it.

#### Scenario: Weekdays excluded from the count

- **WHEN** a seven-day range is aggregated with the weekday set naming five weekdays
- **THEN** the number of counted days is 5
- **AND** submissions made on the two excluded days do not contribute to any per-day count
- **AND** those two days are not counted as missed for anybody

#### Scenario: Weekday set omitted

- **WHEN** a seven-day range is aggregated with no weekday set supplied
- **THEN** the number of counted days is 7

#### Scenario: Counted days reported with the figures

- **WHEN** any range aggregation is produced
- **THEN** it reports the number of counted days and the weekday set that produced it

#### Scenario: A weekday set that excludes every day in the range

- **WHEN** a range is aggregated with a weekday set that matches none of the days in it
- **THEN** the request is rejected rather than reporting every account as fully complete against a denominator of zero

### Requirement: Each account has a derived status for a range

The system SHALL derive a single rollup status for each account over a range from its complete-day count: fully complete when every counted day was complete, none when no counted day was complete, and partial otherwise. The rollup SHALL be reported alongside the per-day counts, never instead of them, because it cannot distinguish one missed day from twenty-nine.

#### Scenario: Fully complete range

- **WHEN** an account submitted attendance and posted a daily update on every counted day
- **THEN** its rollup status is fully complete

#### Scenario: Nothing complete in the range

- **WHEN** an account completed no counted day, whether or not it submitted attendance on some of them
- **THEN** its rollup status is none

#### Scenario: Some days complete

- **WHEN** an account completed at least one counted day but not all of them
- **THEN** its rollup status is partial

### Requirement: Days a person did neither are counted separately from days they were incomplete

The system SHALL report, for each account over a range, both the number of counted days on which the account did NEITHER of the two things and the number on which it did not do BOTH. These SHALL be distinct figures under distinct names, because the reminder threshold acts on the first and an administrator reading the second would set that threshold against a number the broadcast does not use.

#### Scenario: Attendance every day, no updates

- **WHEN** an account submitted attendance on all five counted days and posted no daily update on any of them
- **THEN** its incomplete-day count is 5
- **AND** its missed-both-day count is 0

#### Scenario: Nothing at all

- **WHEN** an account submitted nothing and posted nothing across five counted days
- **THEN** both its incomplete-day count and its missed-both-day count are 5

### Requirement: A range aggregation runs in a bounded number of queries

The system SHALL compute a range aggregation in the same fixed number of queries as a single-date aggregation, independent of the number of days in the range and the number of members. It SHALL NOT issue one query per day, one query per member, or materialise one row per member per day.

#### Scenario: Query count does not grow with the range

- **WHEN** a ninety-day range is aggregated across roughly five thousand members
- **THEN** the number of database queries issued is the same as for a one-day range

#### Scenario: Query count does not grow with member count

- **WHEN** the member directory doubles in size
- **THEN** the number of queries for a range aggregation is unchanged

### Requirement: Range results support the dashboard's filtering, sorting and paging

The system SHALL support, for a range aggregation, the same server filter, search, departed-member handling and paging as the single-date aggregation, and SHALL additionally support filtering by rollup status and by a minimum missed-both-day count. Sorting SHALL additionally be available on the missed-both-day count, the complete-day count, and the rollup status. Sort columns and directions SHALL come from a closed allowlist and SHALL never be interpolated from client input.

The search filter SHALL be applied after accounts are grouped, so that a nickname matching in one server does not drop that account's membership in another server from its own row.

#### Scenario: Filter by rollup status

- **WHEN** a range page is requested filtered to the partial rollup status
- **THEN** only accounts with that rollup status are returned
- **AND** the reported total reflects the filtered count

#### Scenario: Filter by a minimum missed-both-day count

- **WHEN** a range page is requested with a minimum missed-both-day count of two
- **THEN** only accounts that did neither thing on at least two counted days are returned

#### Scenario: The single-date status filter is not accepted for a range

- **WHEN** a range page is requested with the single-date four-bucket status filter
- **THEN** the request is rejected, because that filter describes one day and cannot describe a span

#### Scenario: Sort by missed-both days

- **WHEN** a range page is sorted by the missed-both-day count in descending order
- **THEN** the accounts that did neither thing on the most counted days appear first

#### Scenario: Search matches a nickname in one server only

- **WHEN** an account is in two configured servers under different nicknames and the search term matches one of them
- **THEN** the account appears once with both of its servers listed

### Requirement: A single account's per-day breakdown can be retrieved for a range

The system SHALL provide, for one account over a range, the per-day facts behind its counts — for each counted day, whether attendance was submitted and whether a daily update was posted — together with the daily-update messages it posted within the range across every server it belongs to.

#### Scenario: Per-day breakdown

- **WHEN** the breakdown for an account over a five-day range is requested
- **THEN** the response carries one entry per counted day, each stating whether attendance and an update were recorded
- **AND** the entries reconcile with the account's per-day counts

#### Scenario: Breakdown reached through any of the account's member records

- **WHEN** the breakdown is requested using the account's member record in one server
- **THEN** it reports the whole account, including days satisfied by a message posted in another server

#### Scenario: Excluded weekdays are absent from the breakdown

- **WHEN** the breakdown is requested with a weekday set that excludes some days in the range
- **THEN** those days do not appear as entries

## MODIFIED Requirements

### Requirement: Members missing a daily update can be listed for reminders

The system SHALL provide the set of members to remind, with the Discord snowflake ID needed to DM each of them and the server each member record belongs to. The set SHALL span every configured server unless one is named.

The set SHALL be selectable by either of two criteria over either a single date or a range of dates:

- members whose account has no daily update recorded, the existing criterion; or
- members whose account did NEITHER submit attendance NOR post a daily update.

Over a range, the criterion SHALL be applied per counted day and the member SHALL be included only when the number of days failing it reaches a stated minimum, so that "missed two of the past three days" is expressible. Over a single date the minimum SHALL be one.

Whether a member is missing SHALL be decided per ACCOUNT and SHALL be derived from the same aggregation the dashboard reads, so that a person the dashboard shows as having missed a given number of days is exactly the person a broadcast at that threshold targets.

#### Scenario: Reminder target list

- **WHEN** the members to remind for a date are requested
- **THEN** each returned member carries their Discord snowflake user ID, normalized username, display name, and the server their record belongs to

#### Scenario: Target list spans servers

- **WHEN** the target list is built without naming a server
- **THEN** members failing the criterion in every configured server are included

#### Scenario: A person missing in both servers appears once per server

- **WHEN** a Discord account is a member of two configured servers and fails the criterion
- **THEN** the target list carries one entry per server
- **AND** the entries carry the same Discord snowflake, so a caller can group them to avoid contacting that person twice

#### Scenario: Departed members are not targeted

- **WHEN** the target list is built
- **THEN** members no longer in the server their record belongs to are excluded, since they cannot be reminded there

#### Scenario: Member with an update is not targeted

- **WHEN** a member posted at least one daily-update message on the date in their server and the criterion is the missing-update one
- **THEN** they are absent from the target list for that server regardless of whether they submitted attendance
- **AND** their record in another server where they posted nothing is still targeted

#### Scenario: Attendance alone does not exempt under the missed-both criterion

- **WHEN** the criterion is the missed-both one and an account submitted attendance but posted no update on a day
- **THEN** that day does not count against the account's threshold, because it did one of the two things

#### Scenario: Threshold not reached

- **WHEN** a three-day range is requested with a minimum of two and an account did neither thing on exactly one counted day
- **THEN** that account's member records are absent from the target list

#### Scenario: Threshold reached

- **WHEN** a three-day range is requested with a minimum of two and an account did neither thing on two counted days
- **THEN** one entry per server the account is currently in appears in the target list
- **AND** each entry carries the number of counted days the account failed, so the recipient audit records why it was targeted

#### Scenario: Excluded weekdays cannot push an account over the threshold

- **WHEN** a range is requested with a weekday set that excludes a day on which an account did nothing
- **THEN** that day does not contribute to the account's failing-day count

#### Scenario: The target list and the dashboard agree

- **WHEN** the dashboard is filtered to a minimum missed-both-day count over a range and a target list is built for the same range, criterion and minimum
- **THEN** the two describe the same set of accounts
