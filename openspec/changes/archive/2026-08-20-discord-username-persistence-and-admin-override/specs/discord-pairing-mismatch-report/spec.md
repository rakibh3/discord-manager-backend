## ADDED Requirements

### Requirement: A mismatch report is recorded when a paired student cannot enter their real handle

The system SHALL accept, on the public attendance submission, an optional flag indicating that the student cannot enter their real Discord username. When the submitted address is held by an active roster entry that already holds a Discord account, and the submitted handle differs from the paired account, and the flag is set, the system SHALL record a "discord-pairing-mismatch report" tied to that pairing.

The recording SHALL be attempted only after the submission has been accepted (attendance row written), and SHALL NOT change the submission's response. It SHALL consume at most one indexed write against the reports table.

The report SHALL carry the roster entry identifier, the paired account identifier, the submitting account identifier, the submitted normalized handle, the rejection reason (the recorded pairing did not match the submitted handle), the submission's Asia/Dhaka date, and the report time. The report's status SHALL be set to `open` on creation.

The report SHALL be created with the database uniqueness constraint that, for a single roster entry and a single Asia/Dhaka date, at most one open report exists. A second submission with the flag set on the same day for the same pair SHALL NOT create a duplicate open report.

#### Scenario: First mismatch report of the day is recorded

- **WHEN** an accepted submission carries an enrolled address whose entry is paired with a different account, and the flag is set
- **THEN** the submission is accepted
- **AND** one mismatch report is created against the pairing with status `open`
- **AND** the report records the paired account, the submitting account, the submitted handle, today's Dhaka date, and the report time

#### Scenario: Same pairing flagged twice on the same day

- **WHEN** a second accepted submission with the flag set arrives on the same Dhaka date for the same roster entry
- **THEN** no additional record is created
- **AND** the existing open report is left unchanged

#### Scenario: Flag set on an unpaired entry

- **WHEN** an accepted submission carries an enrolled address whose entry holds no Discord account, and the flag is set
- **THEN** no mismatch report is created
- **AND** the submission responds as it would without the flag

#### Scenario: Report does not change the submission response

- **WHEN** a mismatch report is recorded
- **THEN** the submission response body and status are identical to those of an accepted submission without the flag

#### Scenario: Report write failure does not affect the submission

- **WHEN** the report write raises an error after the attendance has been committed
- **THEN** the submission still answers success
- **AND** the attendance rows remain committed
- **AND** the failure is logged

### Requirement: Mismatch reports are visible to administrators on a paginated listing

The system SHALL expose, to administrators only, an endpoint listing mismatch reports. The listing SHALL be paginated, SHALL default to reports in status `open` ordered by report time descending, and SHALL accept filters for status, a search term over the address, and a date range over the report time.

Each row SHALL carry the report identifier, the roster entry's name, the paired account's normalized handle, the submitting account's normalized handle, the submitted handle, the rejection reason, the submission Dhaka date, the report time, and the current status.

The response SHALL report the total count of reports matching the query alongside the page.

#### Scenario: Open reports listed

- **WHEN** an administrator requests the listing without parameters
- **THEN** the response is 200 with a page of `open` reports, most recent first, and the total matching count

#### Scenario: Listing filtered by status

- **WHEN** an administrator filters for `reassigned` reports
- **THEN** only reports in that status are returned

#### Scenario: Listing filtered by date range

- **WHEN** an administrator filters for a date range over the report time
- **THEN** only reports whose report time falls in the range are returned

#### Scenario: Search by address

- **WHEN** an administrator searches by a fragment of the address
- **THEN** only reports whose entry's address contains that fragment are returned

#### Scenario: Page beyond the end

- **WHEN** an administrator requests a page past the last one
- **THEN** an empty page is returned with the correct total, rather than an error

#### Scenario: Without an administrator token

- **WHEN** the listing endpoint is called with no administrator token
- **THEN** the response is 401 and no report row is read

### Requirement: An administrator can take the final action on a mismatch report

The system SHALL expose, to administrators only, an endpoint that performs the final action on an open mismatch report. The endpoint SHALL accept a single action: `reassign` or `dismiss`.

When the action is `reassign`, the system SHALL rewrite the pairing on the referenced roster entry to the submitted account, in a single conditional write that succeeds only while the entry still holds the original paired account. The system SHALL set the report's status to `reassigned`, record the reviewing administrator's identifier, and record the action time.

When the action is `dismiss`, the system SHALL set the report's status to `dismissed`, leave the pairing unchanged, record the reviewing administrator's identifier, and record the action time.

The endpoint SHALL refuse the action when the report is not in status `open`, with a message giving the current status. The endpoint SHALL refuse the action when the submitted account no longer resolves to a current member of any configured guild, with a message naming the membership check.

#### Scenario: Reassignment rewrites the pairing

- **WHEN** an administrator submits a `reassign` action for an open report whose entry still holds the originally paired account
- **THEN** the roster entry's paired account is rewritten to the submitted account
- **AND** the report's status is `reassigned`
- **AND** the reviewing administrator and the action time are recorded

#### Scenario: Reassignment while the original pairing has changed

- **WHEN** an administrator submits a `reassign` action for an open report whose entry no longer holds the originally paired account
- **THEN** the action is refused as a conflict
- **AND** the report's status remains `open`
- **AND** no roster entry is modified

#### Scenario: Dismiss leaves the pairing unchanged

- **WHEN** an administrator submits a `dismiss` action for an open report
- **THEN** the report's status is `dismissed`
- **AND** the reviewing administrator and the action time are recorded
- **AND** the pairing is unchanged

#### Scenario: Action on a closed report

- **WHEN** an administrator submits an action for a report whose status is `reassigned` or `dismissed`
- **THEN** the action is refused with a message giving the current status
- **AND** no report or pairing row is modified

#### Scenario: Reassignment with a non-member account

- **WHEN** an administrator submits a `reassign` action for an open report whose submitted account is no longer a current member of any configured guild
- **THEN** the action is refused with a message naming the membership check
- **AND** the report's status remains `open`
- **AND** no roster entry is modified

#### Scenario: Without an administrator token

- **WHEN** the action endpoint is called with no administrator token
- **THEN** the response is 401 and no report or pairing row is modified

#### Scenario: Unknown action

- **WHEN** an administrator submits an action other than `reassign` or `dismiss`
- **THEN** the response is 400 with a message naming the supported actions

### Requirement: Mismatch reports never reach a public endpoint

The system SHALL NOT expose any mismatch report, the submitted handle, the paired account, or any count of mismatch reports on an endpoint reachable without an administrator token. The public verification endpoint SHALL continue to accept no email parameter and SHALL NOT report any per-pairing mismatch state.

#### Scenario: Public verification endpoint

- **WHEN** the public verification endpoint is called
- **THEN** it accepts no email parameter
- **AND** it reports no per-pairing mismatch state

#### Scenario: Public submission endpoint

- **WHEN** the public submission endpoint is called
- **THEN** its response carries no paired-account identifier, no count of open reports, and no record of a report being created
