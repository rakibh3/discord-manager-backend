## ADDED Requirements

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