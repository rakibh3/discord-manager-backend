## ADDED Requirements

### Requirement: A roster entry may record the Discord account it belongs to

The system SHALL allow an enrolment roster entry to hold one optional Discord account identifier and the instant that pairing was first recorded, in addition to the name, address, and phone number it holds today. Both fields SHALL be optional, and an entry without them SHALL remain a complete, valid, enrolled entry.

The roster SHALL remain unscoped to a Discord server. The account identifier names a **person** — one account is one person across every configured server — so recording it does not make an entry describe a membership and does not introduce a server identifier by another name.

At most one entry SHALL hold a given account identifier, enforced by a database uniqueness constraint. Entries holding no account identifier SHALL be exempt, so any number of entries may be unpaired at once.

Deactivation SHALL continue to be a flag and SHALL leave a recorded pairing intact, so reinstating a mistakenly removed person restores them with everything already known about them.

#### Scenario: Entry stored without an account

- **WHEN** an entry is created for a person with a name, an address, and a phone number
- **THEN** it is stored with no account identifier and no pairing instant
- **AND** it is active and enrolled

#### Scenario: Account recorded on an entry

- **WHEN** an account identifier is recorded against an entry
- **THEN** the entry holds that identifier and the instant it was recorded
- **AND** its name, address, phone number, and active flag are unchanged

#### Scenario: Two entries claim one account

- **WHEN** an account identifier already held by one entry is written to another
- **THEN** the database rejects it as a duplicate

#### Scenario: Many entries without accounts

- **WHEN** the roster holds thousands of entries that have never been paired
- **THEN** all of them are stored without conflict

#### Scenario: Deactivation preserves the pairing

- **WHEN** a paired entry is deactivated and later reinstated
- **THEN** it still holds the same account identifier and pairing instant

#### Scenario: Still no server identifier

- **WHEN** any roster entry is read while several servers are configured
- **THEN** it carries no server identifier
- **AND** the same set of entries is returned regardless of which server is being considered
