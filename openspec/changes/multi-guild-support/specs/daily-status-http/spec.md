## MODIFIED Requirements

### Requirement: Daily status counts are served over an admin-only HTTP endpoint

The system SHALL expose `GET /api/daily-status/counts` as an admin-only endpoint that returns the seven overview figures for a given Dhaka calendar date, optionally narrowed to one configured server by a `guildId` query parameter, together with a per-server breakdown carrying the same figures. All figures SHALL be JSON numbers, never strings or BigInt values. The response SHALL echo the requested date back.

The combined figures SHALL count PEOPLE: a Discord account in two configured servers contributes one. The per-server breakdown SHALL count that server's own memberships, so the same account contributes one to each server. The breakdown therefore SHALL NOT be expected to sum to the combined figures, and the difference between them is the overlap.

#### Scenario: Counts for today

- **WHEN** an authenticated admin requests `GET /api/daily-status/counts?date=2026-08-17`
- **THEN** the response is 200 with `totalMembers`, `attendanceSubmitted`, `dailyUpdateSubmitted`, `bothComplete`, `missingUpdateOnly`, `missingAttendanceOnly`, and `missingBoth` as JSON numbers
- **AND** the four status buckets sum to `totalMembers`
- **AND** the response includes a `date` field echoing `2026-08-17`
- **AND** the response includes a `byServer` array carrying the same seven figures per configured server, each with its `guildId` and label

#### Scenario: An account in two servers is counted once combined

- **WHEN** counts are requested with no server filter and one account is a current member of two configured servers
- **THEN** that account contributes one to `totalMembers`
- **AND** it contributes one to each entry of `byServer`
- **AND** the sum of `byServer.totalMembers` exceeds `totalMembers` by the number of such overlapping accounts

#### Scenario: A per-server figure credits work done elsewhere

- **WHEN** an account in two servers posted its daily update in only one of them
- **THEN** it is counted as having submitted an update in **both** servers' entries of `byServer`

#### Scenario: Counts for one server

- **WHEN** the request includes `guildId=` a configured server
- **THEN** the figures cover that server only
- **AND** `byServer` carries that one server

#### Scenario: Counts for an unconfigured server

- **WHEN** the request includes a `guildId` that is not configured
- **THEN** the response is 400 naming the unknown server

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

The system SHALL expose `GET /api/daily-status` as an admin-only endpoint that returns a paginated, filterable, searchable list of per-member status for a given date, across every configured server or narrowed to one by a `guildId` query parameter. The `meta.total` field SHALL reflect the filtered count (after `guildId`, `status` and `search` are applied), not the total guild size.

#### Scenario: Basic page request

- **WHEN** an authenticated admin requests `GET /api/daily-status?date=2026-08-17&page=1&limit=50`
- **THEN** the response is 200 with up to 50 member rows drawn from every configured server and `meta` containing `page`, `limit`, and `total`

#### Scenario: Filter by server

- **WHEN** the request includes `guildId=` a configured server
- **THEN** only that server's members are returned
- **AND** `meta.total` reflects that server's filtered count

#### Scenario: Unconfigured server requested

- **WHEN** the request includes a `guildId` that is not configured
- **THEN** the response is 400 naming the unknown server

#### Scenario: Filter by status

- **WHEN** the request includes `status=MISSING_UPDATE`
- **THEN** only members with status `MISSING_UPDATE` are returned
- **AND** `meta.total` reflects the count of members with that status

#### Scenario: Search narrows results

- **WHEN** the request includes `search=rakib`
- **THEN** only members whose name, phone, email, or Discord username matches case-insensitively are returned

#### Scenario: Server, status and search combine as AND

- **WHEN** `guildId`, `status=MISSING_BOTH` and `search=rahman` are all supplied
- **THEN** only members matching all three are returned

#### Scenario: Default pagination

- **WHEN** `page` and `limit` are omitted
- **THEN** the response defaults to page 1, limit 50

#### Scenario: Row shape

- **WHEN** a page is returned
- **THEN** each row carries `discordUserId`, `memberId`, `memberIds`, `servers` (each with `guildId` and `label`), `serverCount`, `discordUsername`, `displayName`, `name`, `email`, `phone`, `hasAttendance`, `hasDailyUpdate`, `status`, and `attendanceSubmittedAt` (ISO string or null)

#### Scenario: The same person in two servers

- **WHEN** a Discord account is a current member of two configured servers and no server filter is applied
- **THEN** exactly ONE row is returned for that account
- **AND** `servers` names both servers and `serverCount` is two
- **AND** the row's status credits work done in either server

#### Scenario: A row under a server filter

- **WHEN** the list is narrowed to one configured server and a listed account is also in another
- **THEN** `servers` names only the filtered server
- **AND** `serverCount` still reports two, so the overlap remains visible from a single-server view
- **AND** the status is unchanged by the filter

#### Scenario: A search term matching one server's nickname

- **WHEN** a search term matches an account's nickname in one server but not in the other
- **THEN** the account is returned once with both of its servers intact
- **AND** the match does not drop the other server from `servers`

### Requirement: Single member daily status is served over an admin-only HTTP endpoint

The system SHALL expose `GET /api/daily-status/members/:memberId` as an admin-only endpoint that returns one PERSON's status for a date, plus that day's daily-update messages. The member ID SHALL identify one member record, and the endpoint SHALL resolve it to the whole Discord account behind it, so a link built from either server's record describes the same person.

#### Scenario: Member with messages

- **WHEN** an authenticated admin requests a known member's status for a date on which they posted messages
- **THEN** the response is 200 with the same row fields the list returns, plus a `messages` array where each message has `id`, `content`, `postedAt` (ISO string), `guildId`, and `serverLabel`

#### Scenario: Member with no messages

- **WHEN** a member posted nothing on the requested date
- **THEN** the response is 200 with `messages: []`

#### Scenario: Account present in another server

- **WHEN** the requested member record's Discord account also holds a record in another configured server
- **THEN** the response describes the whole account: its status credits work done in either server, and `messages` carries that day's messages from both, ordered by send time as one timeline
- **AND** each message names the server it was posted in
- **AND** the response reports that the account is present in more than one server

#### Scenario: Either server's member ID resolves to the same person

- **WHEN** the same account's record in server A and its record in server B are each requested for the same date
- **THEN** both responses describe the same person with the same status and the same messages

#### Scenario: Unknown member

- **WHEN** the `memberId` does not match any member record in the directory
- **THEN** the response is 404

#### Scenario: Message timestamp uses messageCreatedAt

- **WHEN** a message was sent at 23:58 and persisted at 00:01
- **THEN** `postedAt` reflects the 23:58 send time, not the persistence time

### Requirement: Filtered export is served over an admin-only HTTP endpoint

The system SHALL expose `GET /api/daily-status/export` as an admin-only endpoint that returns a downloadable file (CSV or XLSX) of the filtered member status for a date, honouring the same optional `guildId` filter as the list endpoint. Each exported row SHALL be one person and SHALL name every server that person belongs to.

#### Scenario: CSV export

- **WHEN** an authenticated admin requests `GET /api/daily-status/export?date=2026-08-17&format=csv`
- **THEN** the response is a file with `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="daily-status-2026-08-17.csv"`
- **AND** columns are `servers`, `discordUsername`, `displayName`, `name`, `phone`, `email`, `status`, `hasAttendance`, `hasDailyUpdate`, `attendanceSubmittedAt`
- **AND** the `servers` cell names every server the person belongs to, because one row is one person rather than one membership

#### Scenario: Export honours the server filter

- **WHEN** the export request includes `guildId=` a configured server
- **THEN** only people holding a record in that server appear in the exported file, once each
- **AND** the filename identifies the server as well as the date

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

## ADDED Requirements

### Requirement: The configured servers are discoverable over HTTP

The system SHALL expose the configured servers to an authenticated administrator, so a dashboard can build a server filter without the identifiers being hard-coded in the client.

#### Scenario: Listing the servers

- **WHEN** an authenticated admin requests the configured servers
- **THEN** the response carries each server's `guildId`, label, and whether the bot currently reaches it

#### Scenario: Single-server deployment

- **WHEN** only one server is configured
- **THEN** the response carries that one server, so the client's filter degrades to a single option rather than being absent

#### Scenario: Without authentication

- **WHEN** the request carries no authorization token
- **THEN** the response is 401
