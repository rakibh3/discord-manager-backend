# roster-admin-http Specification

## Purpose

Exposes the roster to the administrators who maintain it — listing, correcting, deactivating, importing, reading the import history, and reading or changing the enforcement setting. Every route here is behind an administrator token, without the exception the public attendance endpoints carry: those endpoints are unauthenticated because students hold no credential and the guild-membership check stands in for one, but the roster is the names, email addresses, and phone numbers of thousands of enrolled people, and there is no membership check that could stand in for a credential over contact data. The listing is paginated, searchable, and reports the total matching count alongside the page, so the size of the roster is legible without paging through it. Corrections are refused rather than merged when an address is moved onto one another entry already holds, because a silent merge collapses two people into one. Removal is deactivation and is reversible; no route deletes an entry outright, so the same history that survives a mistaken import survives a mistaken removal. The enforcement setting is served together with the count of active entries, so the effect of turning the gate on is visible before it is turned on, and enabling against an empty roster is refused with a message that names the reason — the alternative is a change that looks like it succeeded and locks out every student in every server.

## Requirements

### Requirement: The roster surface is administrator-only

The system SHALL place every roster endpoint — listing, correcting, deactivating, import, import history, and the enforcement setting — behind administrator authentication. No roster endpoint SHALL be reachable without an administrator token.

The roster holds the names, email addresses, and phone numbers of every enrolled person. It is contact data about thousands of students, and unlike the attendance form there is no membership check that could stand in for a credential here.

#### Scenario: Anonymous caller

- **WHEN** any roster endpoint is called with no administrator token
- **THEN** the request is rejected as unauthorized before any roster row is read

#### Scenario: Authenticated administrator

- **WHEN** an administrator with a valid token calls a roster endpoint
- **THEN** the request is served

#### Scenario: No roster data on a public endpoint

- **WHEN** the public attendance endpoints are called
- **THEN** none of them returns a roster entry, a roster count, or any part of a stored email address

### Requirement: The roster is listable, searchable, and paginated

The system SHALL expose a paginated listing of roster entries returning each entry's identifier, name, email address, phone number, active flag, and the times it was created and last updated. The listing SHALL accept a free-text search matching against name and email address, and a filter selecting active entries, inactive entries, or both.

The listing SHALL report the total number of entries matching the query alongside the page, so an administrator can see how large the roster is without paging through it.

#### Scenario: First page returned

- **WHEN** an administrator lists the roster without parameters
- **THEN** a bounded page of entries is returned together with the total matching count

#### Scenario: Search by partial name or address

- **WHEN** an administrator searches for a fragment of a name or an email address
- **THEN** the entries whose name or address contains that fragment are returned

#### Scenario: Filter by active state

- **WHEN** an administrator filters for inactive entries
- **THEN** only deactivated entries are returned

#### Scenario: Page beyond the end

- **WHEN** an administrator requests a page past the last one
- **THEN** an empty page is returned with the correct total, rather than an error

### Requirement: An entry can be corrected in place

The system SHALL allow an administrator to correct a single roster entry's name, email address, or phone number. Changing an address to one another entry already holds SHALL be refused as a conflict rather than silently merging the two people.

#### Scenario: Name corrected

- **WHEN** an administrator changes an entry's name
- **THEN** the stored entry carries the new name

#### Scenario: Address corrected

- **WHEN** an administrator changes an entry's email address to one no other entry holds
- **THEN** the entry is stored under the normalized new address
- **AND** the old address no longer resolves to it

#### Scenario: Address already held by another entry

- **WHEN** an administrator changes an entry's address to one another entry holds
- **THEN** the request is refused as a conflict
- **AND** neither entry is changed

#### Scenario: Entry does not exist

- **WHEN** an administrator corrects an entry that no longer exists
- **THEN** the request is refused as not found

### Requirement: Removing an entry deactivates it and is reversible

The system SHALL satisfy a request to remove a roster entry by deactivating it, and SHALL allow an administrator to reactivate a deactivated entry. No roster endpoint SHALL delete an entry outright.

#### Scenario: Entry removed

- **WHEN** an administrator removes an entry
- **THEN** the entry is reported as inactive and no longer counts as enrolled

#### Scenario: Removal reversed

- **WHEN** an administrator reactivates a previously removed entry
- **THEN** the entry counts as enrolled again with its stored details

#### Scenario: Already inactive

- **WHEN** an administrator removes an entry that is already inactive
- **THEN** the request succeeds and the entry remains inactive

### Requirement: The enforcement setting is readable and changeable, and reports why it may not be enabled

The system SHALL expose the current enforcement setting to administrators together with the number of active roster entries, so the effect of enabling it is visible before it is enabled. A request to enable enforcement while no active entry exists SHALL be refused with a message naming the empty roster; a request to disable it SHALL always succeed.

#### Scenario: Setting read

- **WHEN** an administrator reads the enforcement setting
- **THEN** the response reports whether it is enabled, the number of active roster entries, and which administrator last changed it

#### Scenario: Enabling with an empty roster

- **WHEN** an administrator enables enforcement while the roster holds no active entries
- **THEN** the request is refused with a message naming the empty roster
- **AND** the stored setting is unchanged

#### Scenario: Enabling with a populated roster

- **WHEN** an administrator enables enforcement while active entries exist
- **THEN** the setting is stored as enabled and the change is attributed to that administrator

#### Scenario: Disabling

- **WHEN** an administrator disables enforcement
- **THEN** the request succeeds regardless of the roster's contents

### Requirement: Import history is readable

The system SHALL expose the recorded import history to administrators, most recent first, with each record's file name, performing administrator, time, and resulting counts.

#### Scenario: History listed

- **WHEN** an administrator reads the import history
- **THEN** past imports are returned most recent first

#### Scenario: No imports yet

- **WHEN** the history is read before any import has run
- **THEN** an empty list is returned rather than an error

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

### Requirement: The mismatch-report listing is reachable through the administrator HTTP surface

The system SHALL expose `GET /api/roster/discord-mismatch-reports` to administrators only, returning a paginated page of discord-pairing-mismatch reports with the entry's name and address, the paired account, the submitting account, the submitted handle, the rejection reason, the submission Dhaka date, the report time, and the current status. The response SHALL report the total count of matching reports alongside the page.

The listing SHALL accept a status filter (`open`, `reassigned`, `dismissed`), a search term over the address, a date range over the report time, and pagination. It SHALL NOT accept a paired-account filter or a submitting-account filter, so that no caller can enumerate Discord accounts by combining filters.

#### Scenario: Listing open reports

- **WHEN** an administrator requests the listing without parameters
- **THEN** the response is 200 with the first page of `open` reports, most recent first, and the total matching count

#### Scenario: Filter by status

- **WHEN** an administrator filters for `dismissed` reports
- **THEN** only reports in that status are returned

#### Scenario: Filter by address fragment

- **WHEN** an administrator searches by a fragment of the address
- **THEN** only reports whose entry's address contains that fragment are returned

#### Scenario: Filter by date range

- **WHEN** an administrator filters for a date range over the report time
- **THEN** only reports whose report time falls in the range are returned

#### Scenario: Page beyond the end

- **WHEN** an administrator requests a page past the last one
- **THEN** an empty page is returned with the correct total

#### Scenario: Without an administrator token

- **WHEN** the endpoint is called with no administrator token
- **THEN** the response is 401 and no report row is read

### Requirement: The mismatch-report final-action endpoint is reachable through the administrator HTTP surface

The system SHALL expose `POST /api/roster/discord-mismatch-reports/:id/action` to administrators only, accepting a single action: `reassign` or `dismiss`. The endpoint SHALL refuse any other action with a 400 response naming the supported actions.

#### Scenario: Reassignment by an administrator

- **WHEN** an administrator submits a `reassign` action for an open report whose entry still holds the originally paired account
- **THEN** the response is 200, the report's status is `reassigned`, the entry's pairing is rewritten to the submitted account, and the reviewing administrator is recorded

#### Scenario: Dismissal by an administrator

- **WHEN** an administrator submits a `dismiss` action for an open report
- **THEN** the response is 200, the report's status is `dismissed`, the pairing is unchanged, and the reviewing administrator is recorded

#### Scenario: Action on a closed report

- **WHEN** an administrator submits an action for a report whose status is `reassigned` or `dismissed`
- **THEN** the response is 409 with a message giving the current status

#### Scenario: Reassignment while the original pairing has changed

- **WHEN** an administrator submits a `reassign` action for an open report whose entry no longer holds the originally paired account
- **THEN** the response is 409 with a message naming the pairing conflict
- **AND** the report's status remains `open`

#### Scenario: Reassignment with a non-member account

- **WHEN** an administrator submits a `reassign` action for an open report whose submitted account is no longer a current member of any configured guild
- **THEN** the response is 422 with a message naming the membership check

#### Scenario: Unknown action

- **WHEN** an administrator submits an action other than `reassign` or `dismiss`
- **THEN** the response is 400 with a message naming the supported actions

#### Scenario: Unknown report

- **WHEN** an administrator submits an action for a report identifier that does not exist
- **THEN** the response is 404

#### Scenario: Without an administrator token

- **WHEN** the endpoint is called with no administrator token
- **THEN** the response is 401 and no report or pairing row is modified

### Requirement: The engagement listing reports an open mismatch-report count per paired entry

The system SHALL include, on each paired entry returned by the existing engagement listing, the count of open discord-pairing-mismatch reports against that entry. The count SHALL be a JSON number and SHALL be zero for paired entries with no open reports. Unpaired entries SHALL report zero without a database read.

#### Scenario: Paired entry with open reports

- **WHEN** the engagement listing returns a paired entry that has one or more open mismatch reports
- **THEN** the row reports the open-report count

#### Scenario: Paired entry with no open reports

- **WHEN** the engagement listing returns a paired entry that has no open mismatch reports
- **THEN** the row reports an open-report count of zero

#### Scenario: Unpaired entry

- **WHEN** the engagement listing returns an unpaired entry
- **THEN** the row reports an open-report count of zero without an additional database read

#### Scenario: Existing fields unchanged

- **WHEN** the engagement listing is read
- **THEN** every previously-returned field is returned as before, with the open-report count added
