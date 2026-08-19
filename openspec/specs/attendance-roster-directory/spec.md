# attendance-roster-directory Specification

## Purpose

Holds the list of people actually enrolled in the program, and the single stored switch deciding whether attendance submission is gated on that list. It exists because the Discord member directory answers a different question: guild membership proves an account is present in a server, not that the person behind it enrolled. The roster is keyed on a normalized email address because that is the identity the enrolment process already issues, and it is deliberately NOT scoped to a Discord server — an email identifies a person, while membership identifies a presence, and the same enrolled person is the same person in every configured server. Uniqueness rests on a database constraint rather than a read-then-write check, so two concurrent imports cannot both create the same person. Normalization stops at trimming and lowercasing: dot-stripping and `+`-suffix rules are true of some providers and false of others, and applying them would silently merge two people who hold genuinely different addresses. Entries are deactivated rather than deleted, so a mistaken removal is repaired by an ordinary re-import instead of an administrative rescue. The enforcement setting lives in the database rather than the environment so it can be changed without a redeployment, defaults to disabled because a fresh deployment holds an empty roster, and cannot be enabled against an empty roster at all — a gate with nothing to match would refuse every student in every server at once, a total outage that raises no error and is visible only as a collapse in submission volume.

## Requirements

### Requirement: The roster is a list of enrolled people, keyed by email address

The system SHALL store an enrolment roster in which each entry holds a person's full name, their email address, and optionally their phone number. The email address SHALL be the entry's identity: at most one entry SHALL exist for a given normalized email, enforced by a database uniqueness constraint rather than by a read-then-write check, so concurrent imports cannot both create the same person.

The roster SHALL NOT be scoped to a Discord server. An email address identifies a person rather than a membership, and the same person enrolled in the program is the same person in every configured server; storing a server identifier on a roster entry would create a second copy of that person that can disagree with the first.

#### Scenario: Entry stored for an enrolled person

- **WHEN** an entry is written for a person with a name, an email address, and a phone number
- **THEN** the entry is stored with all three values
- **AND** it is retrievable by its email address

#### Scenario: Phone number absent

- **WHEN** an entry is written with a name and an email address but no phone number
- **THEN** the entry is stored with no phone number rather than rejected

#### Scenario: Second entry for the same email

- **WHEN** a write is attempted for an email address an entry already holds
- **THEN** the database rejects it as a duplicate rather than creating a second entry

#### Scenario: Concurrent writes for the same email

- **WHEN** two writes for the same normalized email arrive at the same instant
- **THEN** exactly one creates the entry and the other is resolved as a duplicate

#### Scenario: One roster spans every server

- **WHEN** the roster is read while several Discord servers are configured
- **THEN** the same set of entries is returned regardless of which server is being considered
- **AND** no entry carries a server identifier

### Requirement: Email addresses are normalized before any comparison or storage

The system SHALL normalize an email address — trim surrounding whitespace and lowercase it — before validating it, looking it up, or storing it. No comparison SHALL be made against a raw, un-normalized address, and the stored value SHALL be the normalized one, because the uniqueness constraint is only meaningful over a single canonical form.

Normalization SHALL be limited to trimming and lowercasing. The system SHALL NOT strip dots, SHALL NOT strip `+` suffixes, and SHALL NOT apply any provider-specific alias rule, because those rules are true of some providers and false of others, and applying them would silently merge two people who hold genuinely different addresses.

#### Scenario: Address typed with case and whitespace

- **WHEN** a roster entry is imported with ` Rakib.Hasan@Example.COM `
- **THEN** it is stored as `rakib.hasan@example.com`

#### Scenario: Lookup against a differently-cased address

- **WHEN** the roster is asked about `RAKIB.HASAN@EXAMPLE.COM` and holds `rakib.hasan@example.com`
- **THEN** the lookup matches

#### Scenario: Plus-addressed variant is a different person

- **WHEN** the roster holds `rakib@example.com` and is asked about `rakib+class@example.com`
- **THEN** the lookup does not match
- **AND** the two are storable as separate entries

#### Scenario: Malformed address rejected before storage

- **WHEN** a value that is not a well-formed email address is offered for storage
- **THEN** it is rejected as a validation failure and no entry is written

### Requirement: Entries are deactivated, never deleted

The system SHALL record whether a roster entry is active, and SHALL satisfy a request to remove an entry by marking it inactive rather than by deleting the row. Only active entries SHALL count as enrolled.

An entry that is re-imported after having been deactivated SHALL become active again, so that correcting a mistaken removal is an ordinary import rather than an administrative repair.

#### Scenario: Entry removed by an administrator

- **WHEN** an administrator removes a roster entry
- **THEN** the entry is marked inactive and its row is retained
- **AND** it no longer counts as enrolled

#### Scenario: Inactive entry does not satisfy a lookup

- **WHEN** the roster is asked whether an inactive entry's email is enrolled
- **THEN** the answer is that it is not

#### Scenario: Deactivated person re-imported

- **WHEN** a workbook containing an inactive entry's email address is imported
- **THEN** that entry becomes active again with the imported name and phone number

### Requirement: The roster answers exactly one question about an email address

The system SHALL expose a lookup that, given a normalized email address, reports whether an active roster entry holds it. The lookup SHALL match the address exactly and SHALL NOT use a prefix, substring, or pattern comparison, because such a comparison compiles to a SQL `LIKE` in which `_` is a single-character wildcard and would match a large part of the roster.

The lookup SHALL be a read of the roster alone. It SHALL NOT consult the Discord member directory, SHALL NOT call any Discord API, and SHALL NOT depend on which servers are configured.

#### Scenario: Enrolled address

- **WHEN** the lookup is given an address held by an active entry
- **THEN** it reports the address as enrolled

#### Scenario: Address not on the roster

- **WHEN** the lookup is given a well-formed address no entry holds
- **THEN** it reports the address as not enrolled, rather than raising an error

#### Scenario: Wildcard characters in the address

- **WHEN** the lookup is given an address containing `_` or `%`
- **THEN** those characters are matched literally and no unrelated entry matches

#### Scenario: Lookup performs no Discord work

- **WHEN** the lookup runs
- **THEN** no Discord API request is issued and no member directory row is read

### Requirement: Whether the roster gates submissions is a stored, administrator-controlled setting

The system SHALL store a single enforcement setting deciding whether an attendance submission must carry an enrolled email address. The setting SHALL be stored in the database rather than read from the process environment, so that an administrator can change it without a redeployment, and SHALL record which administrator last changed it and when.

The setting SHALL default to disabled. A newly deployed system holds an empty roster, and a roster gate that is on by default would refuse every student in every server at once with nothing appearing to be wrong.

#### Scenario: Setting has never been configured

- **WHEN** the enforcement setting is read before any administrator has changed it
- **THEN** it is materialized with enforcement disabled and returned, rather than reported as missing

#### Scenario: Setting is changed

- **WHEN** an administrator enables enforcement
- **THEN** the stored setting records that it is enabled, which administrator changed it, and when

#### Scenario: Change takes effect without a restart

- **WHEN** enforcement is enabled and a submission arrives afterwards
- **THEN** that submission is subject to the roster check without the process having been restarted

### Requirement: Enforcement cannot be enabled against an empty roster

The system SHALL refuse a request to enable enforcement while the roster holds no active entries, and SHALL report the refusal as a rejected request naming the empty roster. Enabling the gate with nothing to match against would refuse every submission from every student, which is indistinguishable from an outage and would be discovered only through a collapse in submission volume.

When enforcement IS enabled, an email address that no active entry holds SHALL be refused. There SHALL be no condition under which an enabled gate silently admits an unmatched address, because a gate that disables itself under some circumstance is a gate nobody can reason about.

#### Scenario: Enabling with no entries

- **WHEN** an administrator enables enforcement while the roster holds no active entries
- **THEN** the request is rejected and the setting remains disabled

#### Scenario: Enabling after an import

- **WHEN** an administrator imports a workbook containing at least one valid entry and then enables enforcement
- **THEN** the setting is stored as enabled

#### Scenario: Roster emptied while enforcement is on

- **WHEN** enforcement is enabled and every roster entry is subsequently deactivated
- **THEN** submissions carrying any email address are refused
- **AND** the gate does not silently admit them

#### Scenario: Disabling is always permitted

- **WHEN** an administrator disables enforcement
- **THEN** the request succeeds regardless of how many entries the roster holds

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
