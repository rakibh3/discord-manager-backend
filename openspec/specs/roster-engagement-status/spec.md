# roster-engagement-status Specification

## Purpose

The read model that answers "which enrolled people are doing the work" — one row per roster entry, with each row reporting whether a Discord account is on file and what that person did on the counted days. It exists because the daily-status dashboard answers a different question ("who in our servers is behind") over a different denominator (Discord accounts in configured servers); the roster report's denominator is enrolment. The two views are deliberately not reconciled — they count different populations and diverge in both directions — and the gap is described in three places (this header, the repository file header, and `CLAUDE.md`) because it looks like a bug on the dashboard and would be tempting to "fix" by tightening one to match the other.

## Requirements

### Requirement: Engagement is reported per enrolled person, with enrolment as the denominator

The system SHALL provide a read model whose rows are roster entries — one row per enrolled person — reporting for each whether a Discord account is on file and what that person did on the counted days. The roster SHALL be the driving table, so an entry with no Discord account survives into the result rather than being excluded by the join.

The existing daily-status dashboard counts Discord accounts and answers "who in our servers is behind". This read model counts enrolled people and answers "who that we enrolled has gone dark", which is a different question with a different denominator; the person who never appeared on Discord is invisible to the first and is the whole point of the second.

#### Scenario: Unpaired entry appears in its own report

- **WHEN** engagement is read for a date while an active entry has no Discord account on file
- **THEN** that entry is returned as a row
- **AND** its attendance and daily-update figures are zero

#### Scenario: Paired entry reports its activity

- **WHEN** engagement is read for a date on which a paired person submitted attendance and posted a daily update
- **THEN** that entry's row reports both as recorded

#### Scenario: Deactivated entries are excluded by default

- **WHEN** engagement is read without an explicit status filter
- **THEN** only active roster entries are returned

### Requirement: Activity is credited from the same sources as the dashboard

The system SHALL determine whether an enrolled person submitted attendance or posted a daily update using the same account-keyed credit sources the daily-status aggregation uses, rather than a second implementation. Those sources are keyed on the Discord account with no server filter and no membership filter, and that SHALL remain true here: an enrolled person who posted in any configured server has done the work.

Two implementations of "posted a daily update" would answer differently the first time either was touched, and an administrator comparing the roster report against the dashboard would have no way to tell which was right.

#### Scenario: Work done in one of two servers

- **WHEN** a paired person who is a member of two servers posts a daily update in one of them
- **THEN** the roster report credits the daily update
- **AND** the daily-status dashboard credits it for the same person on the same date

#### Scenario: Work done in a server the person has since left

- **WHEN** a paired person posted a daily update and later left every configured server
- **THEN** the update is still credited for that date

#### Scenario: Figures agree with the dashboard

- **WHEN** the same date is read from the roster report and from the daily-status dashboard for one paired person
- **THEN** both report the same attendance and daily-update facts

### Requirement: Having no Discord account on file is its own status

The system SHALL report a distinct status for an entry with no Discord account, separate from the statuses used for people who are on Discord and behind. An entry with an account on file SHALL be classified with the same four-way status the daily-status dashboard uses for a single date, and with the same day-count figures it uses for a range.

Collapsing "no account on file" into "missing both" would merge two populations that call for opposite actions: one is reachable on Discord and behind, and the other cannot be reached on Discord at all.

#### Scenario: No account on file

- **WHEN** an active entry with no Discord account is reported
- **THEN** its status names that condition specifically
- **AND** it is not reported as missing both

#### Scenario: Paired and behind

- **WHEN** a paired person did neither the attendance nor the update on the counted date
- **THEN** the row reports the same missing-both status the dashboard reports

#### Scenario: Paired but no longer in any server

- **WHEN** an entry is paired with an account that is currently a member of no configured server
- **THEN** the row is reported as paired with an empty server list
- **AND** it is not reported as having no account on file

### Requirement: A single date and a date range are both supported, under the dashboard's rules

The system SHALL report engagement either for one Dhaka calendar date or for a range of them. Range mode SHALL use the same conventions the daily-status range already uses: the counted days are enumerated from the range and an optional weekday set, the weekday numbering is the one used everywhere else in the system, the span is capped at the same maximum number of days, and a weekday set that leaves no counted day SHALL be refused rather than reported.

The cap is a blast-radius control the dashboard already applies, and a report an administrator can read must not be able to describe a period no other part of the system will accept.

#### Scenario: Single date

- **WHEN** engagement is requested for one date
- **THEN** each row reports that day's facts

#### Scenario: Range with a weekday set

- **WHEN** engagement is requested for a range restricted to a weekday set
- **THEN** each row's day counts are computed over only the counted days
- **AND** the number of counted days is reported alongside the rows

#### Scenario: Range longer than the cap

- **WHEN** a range wider than the permitted span is requested
- **THEN** the request is refused as invalid

#### Scenario: Weekday set leaves no counted day

- **WHEN** a range is requested whose weekday set matches none of its days
- **THEN** the request is refused as invalid rather than returning rows with a zero denominator

### Requirement: Overview counts describe the enrolled population

The system SHALL report overview figures for the counted period: how many people are enrolled, how many have a Discord account on file, how many do not, and how the paired people divide across the activity statuses. The paired status figures SHALL sum to the number of paired people, and the paired and unpaired figures SHALL sum to the enrolled total.

#### Scenario: Figures reconcile

- **WHEN** overview counts are read
- **THEN** the paired and unpaired counts sum to the enrolled total
- **AND** the paired status buckets sum to the paired count

#### Scenario: Empty roster

- **WHEN** overview counts are read while no active entry exists
- **THEN** every figure is zero and the request succeeds

### Requirement: Roster totals are not dashboard totals and neither is corrected to match

The system SHALL report the enrolled total independently of the daily-status dashboard's member total, and SHALL NOT reconcile the two. They count different populations — enrolled people versus Discord accounts present in a configured server — and they diverge in both directions: people who enrolled and never joined, and members who are in a server without being on the roll.

Both figures are wanted. The dashboard's answers "how many of our members are done today"; this one answers "how many of the people we enrolled are participating at all".

#### Scenario: Enrolled but never on Discord

- **WHEN** a person is on the roster and has never appeared in any configured server
- **THEN** the roster report counts them
- **AND** the dashboard's member total does not

#### Scenario: A member who is not on the roster

- **WHEN** an account is a member of a configured server and no roster entry is paired with it
- **THEN** the dashboard counts them
- **AND** the roster report does not

#### Scenario: Dashboard figures unchanged

- **WHEN** any daily-status endpoint is read after this read model exists
- **THEN** its figures are derived from the member directory exactly as before

### Requirement: Rows are filterable by pairing state, status, and free text, and are paginated

The system SHALL allow the result to be narrowed to paired entries only, unpaired entries only, or all; to a single status; and by a case-insensitive search over the enrolled person's name and email address. The result SHALL be paginated and SHALL report the total number of rows matching the same filter alongside the page.

Sorting SHALL be restricted to a fixed set of columns and directions, and every other value supplied by a caller SHALL reach the database only as a bound parameter.

#### Scenario: Unpaired only

- **WHEN** the result is narrowed to unpaired entries
- **THEN** every returned row has no Discord account on file

#### Scenario: Search by email

- **WHEN** a search term matching part of an enrolled address is supplied
- **THEN** matching entries are returned regardless of letter case

#### Scenario: Total accompanies the page

- **WHEN** a filtered page is requested
- **THEN** the response reports the total number of entries matching that filter

#### Scenario: Unknown sort column

- **WHEN** a sort column outside the permitted set is requested
- **THEN** the request is refused rather than interpolated into the query

### Requirement: The report is not scoped to a Discord server

The system SHALL NOT accept a server filter on the engagement read model. An unpaired entry belongs to no server, so any server filter would silently drop precisely the population this read model exists to surface, and the roster itself carries no server identifier to filter on.

A paired row SHALL still report which configured servers its account is currently a member of, so a reader can see where each person is.

#### Scenario: Server filter rejected

- **WHEN** a request supplies a server identifier as a filter
- **THEN** it is refused as an unsupported parameter rather than silently ignored

#### Scenario: Servers listed on a paired row

- **WHEN** a paired person is a member of two configured servers
- **THEN** their row names both servers

#### Scenario: No servers on an unpaired row

- **WHEN** an unpaired entry is returned
- **THEN** its server list is empty