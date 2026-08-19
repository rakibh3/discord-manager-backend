## ADDED Requirements

### Requirement: Engagement overview counts are served over an administrator-only endpoint

The system SHALL expose `GET /api/roster/status/counts` to administrators only, returning the engagement figures for a single Dhaka calendar date or for a date range: the enrolled total, how many entries hold a Discord account, how many do not, and how the paired entries divide across the activity statuses. Every figure SHALL be a JSON number. The response SHALL echo the requested period and, in range mode, the number of counted days.

#### Scenario: Counts for a date

- **WHEN** an administrator requests counts for one date
- **THEN** the response is 200 with the enrolled, paired, and unpaired totals and the status buckets as JSON numbers
- **AND** the requested date is echoed

#### Scenario: Counts for a range

- **WHEN** an administrator requests counts for a range with an optional weekday set
- **THEN** the response is 200 and reports the number of counted days alongside the figures

#### Scenario: Without a token

- **WHEN** the endpoint is called with no administrator token
- **THEN** the response is 401 and no roster row is read

#### Scenario: Range beyond the permitted span

- **WHEN** a range wider than the permitted span is requested
- **THEN** the response is 400

### Requirement: The engagement listing is served over an administrator-only endpoint

The system SHALL expose `GET /api/roster/status` to administrators only, returning a paginated page of enrolled people with, for each, their name, address, phone number, whether a Discord account is on file, the servers that account is currently a member of, their activity figures for the period, and their status. The response SHALL report the total number of entries matching the same filter.

The listing SHALL accept a pairing-state filter, a status filter, a search term over name and address, pagination, and a sort drawn from a fixed permitted set. It SHALL NOT accept a server filter.

#### Scenario: Page of enrolled people

- **WHEN** an administrator requests the listing for a date
- **THEN** the response is 200 with a page of rows and the total matching count

#### Scenario: Unpaired filter

- **WHEN** the listing is requested narrowed to entries with no Discord account
- **THEN** every returned row reports no account on file and zero activity

#### Scenario: A server filter is refused

- **WHEN** the listing is requested with a server identifier
- **THEN** the response is 400 rather than a silently unfiltered result

#### Scenario: Unpermitted sort

- **WHEN** the listing is requested with a sort column outside the permitted set
- **THEN** the response is 400

#### Scenario: Without a token

- **WHEN** the endpoint is called with no administrator token
- **THEN** the response is 401

### Requirement: The engagement listing is exportable as a file for outreach

The system SHALL expose `GET /api/roster/status/export` to administrators only, streaming the filtered engagement rows as a CSV attachment carrying the same columns the listing returns, honouring the same period and filters. Cell values SHALL be escaped so that a value beginning with a formula character cannot be interpreted as a formula by a spreadsheet application, and so that delimiters and newlines inside a value cannot break the row.

The export is the deliverable for enrolled people with no Discord account on file. They cannot be reached by direct message because no account is known for them, so the list leaves the system as a file and is acted on by email outside it.

A format the system does not produce SHALL be refused with a message naming the format that is available, rather than served as an incorrectly labelled file.

#### Scenario: Export of unpaired entries

- **WHEN** an administrator exports the listing narrowed to entries with no Discord account
- **THEN** the response is a CSV attachment containing one row per such entry with their name, address, and phone number

#### Scenario: Formula-like value

- **WHEN** an exported value begins with a formula character
- **THEN** it is escaped so a spreadsheet application does not evaluate it

#### Scenario: Unsupported format

- **WHEN** an export is requested in a format the system does not produce
- **THEN** the response is 400 naming the supported format

#### Scenario: Without a token

- **WHEN** the endpoint is called with no administrator token
- **THEN** the response is 401

### Requirement: The entry listing reports whether an entry has a Discord account

The system SHALL include, on each entry returned by the existing roster listing, whether a Discord account is on file and the instant it was recorded. The fields SHALL be additive; every field the listing returns today SHALL continue to be returned with its current name and meaning.

#### Scenario: Paired entry in the listing

- **WHEN** the roster listing returns an entry that holds an account
- **THEN** the row reports the account identifier and the pairing instant

#### Scenario: Unpaired entry in the listing

- **WHEN** the roster listing returns an entry with no account
- **THEN** the row reports no account and no pairing instant

#### Scenario: Existing fields unchanged

- **WHEN** the roster listing is read
- **THEN** the name, address, phone number, active flag, and timestamps are returned as before

### Requirement: Pairing data never reaches an unauthenticated endpoint

The system SHALL NOT expose any recorded pairing, any Discord account identifier drawn from the roster, or any count of paired or unpaired entries on an endpoint reachable without an administrator token. The public verification endpoint SHALL continue to accept no email parameter.

The public verification endpoint carries a per-IP budget of sixty requests a minute. An address parameter there would already be an enumeration oracle over the enrolment roll; with pairings recorded it would additionally map enrolled addresses to Discord accounts.

#### Scenario: Public verification endpoint

- **WHEN** the public verification endpoint is called
- **THEN** it accepts no email parameter
- **AND** its response contains no roster field

#### Scenario: Public window endpoint

- **WHEN** the public window endpoint is called
- **THEN** its only roster-derived field remains the boolean stating whether an enrolled address is required
- **AND** it reports no pairing information
