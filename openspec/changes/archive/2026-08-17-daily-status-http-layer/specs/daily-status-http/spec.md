## ADDED Requirements

### Requirement: Daily status counts are served over an admin-only HTTP endpoint

The system SHALL expose `GET /api/daily-status/counts` as an admin-only endpoint that returns the seven overview figures for a given Dhaka calendar date. All figures SHALL be JSON numbers, never strings or BigInt values. The response SHALL echo the requested date back.

#### Scenario: Counts for today

- **WHEN** an authenticated admin requests `GET /api/daily-status/counts?date=2026-08-17`
- **THEN** the response is 200 with `totalMembers`, `attendanceSubmitted`, `dailyUpdateSubmitted`, `bothComplete`, `missingUpdateOnly`, `missingAttendanceOnly`, and `missingBoth` as JSON numbers
- **AND** the four status buckets sum to `totalMembers`
- **AND** the response includes a `date` field echoing `2026-08-17`

#### Scenario: Counts for a past date

- **WHEN** an authenticated admin requests counts for a date six days ago
- **THEN** the response is 200 with figures reflecting that historical date
- **AND** the request is not rejected for being in the past

#### Scenario: Counts without authentication

- **WHEN** a request to `/api/daily-status/counts` carries no authorization token
- **THEN** the response is 401

#### Scenario: Invalid date format

- **WHEN** a request to `/api/daily-status/counts` carries `date=not-a-date`
- **THEN** the response is 400 with a validation error

#### Scenario: Missing date parameter

- **WHEN** a request to `/api/daily-status/counts` omits the `date` query parameter
- **THEN** the response is 400 with a validation error

### Requirement: Daily status page is served over an admin-only HTTP endpoint

The system SHALL expose `GET /api/daily-status` as an admin-only endpoint that returns a paginated, filterable, searchable list of per-member status for a given date. The `meta.total` field SHALL reflect the filtered count (after `status` and `search` are applied), not the total guild size.

#### Scenario: Basic page request

- **WHEN** an authenticated admin requests `GET /api/daily-status?date=2026-08-17&page=1&limit=50`
- **THEN** the response is 200 with up to 50 member rows and `meta` containing `page`, `limit`, and `total`

#### Scenario: Filter by status

- **WHEN** the request includes `status=MISSING_UPDATE`
- **THEN** only members with status `MISSING_UPDATE` are returned
- **AND** `meta.total` reflects the count of members with that status

#### Scenario: Search narrows results

- **WHEN** the request includes `search=rakib`
- **THEN** only members whose name, phone, email, or Discord username matches case-insensitively are returned

#### Scenario: Status and search combine as AND

- **WHEN** both `status=MISSING_BOTH` and `search=rahman` are supplied
- **THEN** only members matching both criteria are returned

#### Scenario: Default pagination

- **WHEN** `page` and `limit` are omitted
- **THEN** the response defaults to page 1, limit 50

#### Scenario: Row shape

- **WHEN** a page is returned
- **THEN** each row carries `memberId`, `discordUserId`, `discordUsername`, `displayName`, `name`, `email`, `phone`, `hasAttendance`, `hasDailyUpdate`, `status`, and `attendanceSubmittedAt` (ISO string or null)

### Requirement: Single member daily status is served over an admin-only HTTP endpoint

The system SHALL expose `GET /api/daily-status/members/:memberId` as an admin-only endpoint that returns one member's status for a date, plus that day's daily-update messages.

#### Scenario: Member with messages

- **WHEN** an authenticated admin requests a known member's status for a date on which they posted messages
- **THEN** the response is 200 with the member's row fields plus a `messages` array where each message has `id`, `content`, and `postedAt` (ISO string)

#### Scenario: Member with no messages

- **WHEN** a member posted nothing on the requested date
- **THEN** the response is 200 with `messages: []`

#### Scenario: Unknown member

- **WHEN** the `memberId` does not match any member in the directory
- **THEN** the response is 404

#### Scenario: Message timestamp uses messageCreatedAt

- **WHEN** a message was sent at 23:58 and persisted at 00:01
- **THEN** `postedAt` reflects the 23:58 send time, not the persistence time

### Requirement: Filtered export is served over an admin-only HTTP endpoint

The system SHALL expose `GET /api/daily-status/export` as an admin-only endpoint that returns a downloadable file (CSV or XLSX) of the filtered member status for a date.

#### Scenario: CSV export

- **WHEN** an authenticated admin requests `GET /api/daily-status/export?date=2026-08-17&format=csv`
- **THEN** the response is a file with `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="daily-status-2026-08-17.csv"`
- **AND** columns are `discordUsername`, `displayName`, `name`, `phone`, `email`, `status`, `hasAttendance`, `hasDailyUpdate`, `attendanceSubmittedAt`

#### Scenario: Export honours filters

- **WHEN** the export request includes `status=MISSING_BOTH&search=rahman`
- **THEN** only rows matching both criteria appear in the exported file

#### Scenario: Formula injection prevention

- **WHEN** a cell value begins with `=`, `+`, `-`, or `@`
- **THEN** it is prefixed with `'` in the exported file to prevent spreadsheet formula execution

#### Scenario: Large export is streamed

- **WHEN** the export covers more members than the repository's per-page limit
- **THEN** the response is streamed rather than buffered entirely in memory

#### Scenario: Export without authentication

- **WHEN** an export request carries no authorization token
- **THEN** the response is 401

### Requirement: Daily status API field names match the frontend contract

The system SHALL use the field names `bothComplete` and `attendanceSubmittedAt` in API responses, converting from the repository's internal `bothCompleted` and `submittedAt` respectively.

#### Scenario: Counts response uses bothComplete

- **WHEN** the counts endpoint returns the overview figures
- **THEN** the field is named `bothComplete`, not `bothCompleted`

#### Scenario: Row response uses attendanceSubmittedAt

- **WHEN** a member row is returned in the page or detail endpoint
- **THEN** the submission timestamp field is named `attendanceSubmittedAt`, not `submittedAt`

### Requirement: BigInt values are serialized as JSON numbers

The system SHALL convert any `bigint` value from the repository to a JavaScript `number` before including it in a JSON response, so `JSON.stringify` does not throw.

#### Scenario: Counts are numbers

- **WHEN** the counts endpoint serializes its response
- **THEN** every count field is a JSON number, not a string
- **AND** `JSON.stringify` succeeds without throwing `TypeError`
