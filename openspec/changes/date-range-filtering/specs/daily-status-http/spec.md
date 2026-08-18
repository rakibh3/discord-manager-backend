## ADDED Requirements

### Requirement: Daily status endpoints accept a date range as an alternative to a single date

The system SHALL accept, on `GET /api/daily-status`, `GET /api/daily-status/counts`, `GET /api/daily-status/export` and `GET /api/daily-status/members/:memberId`, either a single `date` query parameter or a `from` and `to` pair, and SHALL reject a request that supplies both or only one half of the pair. Both `from` and `to` SHALL be Dhaka calendar dates in `YYYY-MM-DD` and the range SHALL be inclusive of both ends.

Every response SHALL state which mode produced it and SHALL echo the parameters it resolved, so a client never has to infer the shape of the payload from the presence of a field.

#### Scenario: Range requested

- **WHEN** an authenticated admin requests `GET /api/daily-status?from=2026-08-16&to=2026-08-18`
- **THEN** the response is 200
- **AND** it states that it is a range result and echoes `from` and `to`

#### Scenario: Single date still works unchanged

- **WHEN** an authenticated admin requests `GET /api/daily-status?date=2026-08-18`
- **THEN** the response is 200 with the existing single-date row shape and four-bucket status
- **AND** it states that it is a single-date result and echoes `date`

#### Scenario: Both date and range supplied

- **WHEN** a request carries `date` together with `from` or `to`
- **THEN** the response is 400 naming the conflict

#### Scenario: Half a range supplied

- **WHEN** a request carries `from` without `to`, or `to` without `from`
- **THEN** the response is 400 stating that both ends are required

#### Scenario: Reversed range

- **WHEN** a request carries a `to` earlier than its `from`
- **THEN** the response is 400

#### Scenario: Neither date nor range supplied

- **WHEN** a request carries no `date`, `from` or `to`
- **THEN** the response is 400

#### Scenario: Malformed range bound

- **WHEN** a request carries `from=not-a-date`
- **THEN** the response is 400 with a validation error

### Requirement: The date range is capped

The system SHALL reject a range spanning more than 92 days on every daily-status endpoint and on every reminder endpoint that accepts a range, with a 400 stating the limit. The cap SHALL be identical on both, so that any range an administrator can preview on the dashboard is a range they can act on.

#### Scenario: Range within the cap

- **WHEN** a range of 92 days or fewer is requested
- **THEN** it is accepted

#### Scenario: Range beyond the cap

- **WHEN** a range of 93 days or more is requested
- **THEN** the response is 400 stating the maximum span

#### Scenario: A mistyped year is refused, not served

- **WHEN** a request carries `from=2016-08-18&to=2026-08-18`
- **THEN** the response is 400 rather than a five-thousand-member result

### Requirement: Daily status endpoints accept a weekday restriction for a range

The system SHALL accept an optional `daysOfWeek` query parameter alongside `from`/`to`, naming which weekdays inside the range count, using the 0-is-Sunday numbering the channel schedule already uses. Omitting it SHALL count every day in the range. Supplying it in single-date mode SHALL be rejected. Every range response SHALL report the resulting `daysInRange` and echo the `daysOfWeek` it applied.

#### Scenario: Weekday restriction applied

- **WHEN** a seven-day range is requested with `daysOfWeek=0,1,2,3,4`
- **THEN** the response reports `daysInRange` of 5
- **AND** it echoes the weekday set

#### Scenario: Weekday restriction omitted

- **WHEN** a seven-day range is requested with no `daysOfWeek`
- **THEN** the response reports `daysInRange` of 7

#### Scenario: Weekday restriction in single-date mode

- **WHEN** a request carries `date` together with `daysOfWeek`
- **THEN** the response is 400

#### Scenario: Weekday restriction leaving no days

- **WHEN** a range covering only a Monday is requested with `daysOfWeek=0`
- **THEN** the response is 400 rather than reporting every member as fully complete

#### Scenario: Invalid weekday value

- **WHEN** a request carries `daysOfWeek=7`
- **THEN** the response is 400, since valid values are 0 through 6

### Requirement: The daily status page returns per-day counts in range mode

The system SHALL return, for each account in a range page, `daysInRange`, `attendanceDays`, `updateDays`, `completeDays`, `incompleteDays`, `missedBothDays`, and a `rangeStatus` of `ALL_COMPLETE`, `PARTIAL`, or `NONE`, in place of the single-date `status`, `hasAttendance` and `hasDailyUpdate` fields. Every count SHALL be a JSON number. Each row SHALL still describe ONE PERSON and SHALL still carry `memberId`, `memberIds`, `servers` and `serverCount` exactly as in single-date mode.

The response SHALL NOT contain a field named `missedDays`, because the two missed-day figures answer different questions and an unqualified name invites acting on the wrong one.

#### Scenario: Range row shape

- **WHEN** a range page is requested
- **THEN** each row carries the seven range counts and `rangeStatus`
- **AND** each row carries `memberId`, `memberIds`, `servers` and `serverCount`
- **AND** no row carries the single-date `status` field

#### Scenario: An account in two servers is one row

- **WHEN** a range page is requested with no server filter and an account is a current member of two configured servers
- **THEN** it appears as one row with both servers listed
- **AND** `serverCount` reports two even when the page is narrowed to one server

#### Scenario: Counts reconcile against the range

- **WHEN** a range row is read
- **THEN** `completeDays` plus `incompleteDays` equals `daysInRange`
- **AND** `missedBothDays` is less than or equal to `incompleteDays`

#### Scenario: Range paging and total

- **WHEN** a range page is requested with `page` and `limit`
- **THEN** `meta.total` reflects the count after the server, search, `rangeStatus` and `minMissedBothDays` filters are applied

#### Scenario: Filter to the reminder's target set

- **WHEN** a range page is requested with `minMissedBothDays=2`
- **THEN** only accounts that did neither thing on at least two counted days are returned

### Requirement: Daily status counts report range-wide figures

The system SHALL return, for a range counts request, the number of accounts in scope, the number whose rollup status is each of the three values, the number of counted days, and the person-day totals for attendance days, update days, complete days and missed-both days. These SHALL be named distinctly from the seven single-date figures, because they count person-days rather than people. A `byServer` breakdown SHALL carry the same figures per configured server.

The combined figures SHALL count accounts and the breakdown SHALL count each server's own memberships, so the breakdown SHALL NOT be expected to sum to the combined figures — the difference is the overlap, exactly as in single-date mode.

#### Scenario: Range counts

- **WHEN** an authenticated admin requests `GET /api/daily-status/counts?from=2026-08-16&to=2026-08-18`
- **THEN** the response is 200 with `totalMembers`, `allCompleteMembers`, `partialMembers`, `noneMembers`, `daysInRange`, and the person-day totals, all as JSON numbers
- **AND** the three rollup buckets sum to `totalMembers`
- **AND** the response echoes `from`, `to` and `daysOfWeek`

#### Scenario: Range counts per server

- **WHEN** range counts are requested
- **THEN** the response carries a `byServer` array with the same figures per configured server, each with its `guildId` and label

#### Scenario: Range counts do not reuse the single-date field names

- **WHEN** range counts are read
- **THEN** they do not carry `bothCompleted`, `missingUpdateOnly`, `missingAttendanceOnly` or `missingBoth`, which describe one day

#### Scenario: Range counts for one server

- **WHEN** range counts are requested with a `guildId`
- **THEN** the figures cover that server's members only
- **AND** an account in that server that posted its update in another server still counts as having done so

#### Scenario: Range counts for an unconfigured server

- **WHEN** range counts are requested with a `guildId` that is not configured
- **THEN** the response is 400 naming the unknown server

### Requirement: The member detail endpoint returns a per-day breakdown in range mode

The system SHALL return, for `GET /api/daily-status/members/:memberId` in range mode, the account's range counts, one entry per counted day stating whether attendance and a daily update were recorded, and the daily-update messages the account posted within the range across every server it belongs to, merged into one timeline.

#### Scenario: Member range detail

- **WHEN** an authenticated admin requests a member's status over a five-day range
- **THEN** the response carries the account's range counts, five per-day entries, and the messages posted in that range

#### Scenario: Messages from both servers are merged

- **WHEN** the account posted in two configured servers within the range
- **THEN** the timeline carries both servers' messages, each identifying its server

#### Scenario: Unknown member

- **WHEN** the member ID does not exist
- **THEN** the response is 404

### Requirement: The export reflects the mode it was requested in

The system SHALL export the range row shape when `from`/`to` are supplied and the single-date row shape when `date` is supplied, with a header row matching the shape it wrote. The export SHALL apply the same filters as the corresponding list endpoint.

#### Scenario: Range export

- **WHEN** an authenticated admin requests `GET /api/daily-status/export?from=2026-08-16&to=2026-08-18`
- **THEN** the response is a file attachment whose header row names the range count columns and `rangeStatus`
- **AND** the filename identifies the range

#### Scenario: Single-date export unchanged

- **WHEN** an export is requested with `date`
- **THEN** the header row and columns are the existing single-date ones

#### Scenario: Range export honours the filters

- **WHEN** a range export is requested with `guildId`, `search` and `minMissedBothDays`
- **THEN** the exported rows are the same rows the list endpoint returns for those filters

### Requirement: Range requests require an administrator

The system SHALL require a valid administrator token on every daily-status endpoint in range mode, exactly as in single-date mode.

#### Scenario: Range request without authentication

- **WHEN** a range request to any daily-status endpoint carries no authorization token
- **THEN** the response is 401
