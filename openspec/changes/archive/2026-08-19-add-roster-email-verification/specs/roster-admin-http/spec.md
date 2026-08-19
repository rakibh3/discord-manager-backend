## ADDED Requirements

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
