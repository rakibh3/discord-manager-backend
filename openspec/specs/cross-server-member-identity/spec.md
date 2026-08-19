# cross-server-member-identity Specification

## Purpose

Defines how the system treats a single Discord account that holds membership in more than one configured server. The same account is one person and that person owes one day's work; the records that prove it are nevertheless per server, so each server keeps its own membership state and history. The distinction — one record per server, one account across servers — is what makes multi-guild behaviour auditable rather than illusory.

## Requirements

### Requirement: The member directory holds one record per server per Discord account

The directory SHALL store a member record for each server a Discord account belongs to. A person who is in two configured servers SHALL be represented by two records, one per server. Records SHALL NOT be merged across servers.

#### Scenario: A person in one server

- **WHEN** a Discord account is a member of a single configured server
- **THEN** exactly one directory record exists for that account, carrying that server's identifier

#### Scenario: A person in both servers

- **WHEN** a Discord account is a member of two configured servers
- **THEN** two directory records exist, one per server, each carrying its own server identifier
- **AND** each record holds that server's own membership state, join date, departure state, and display name

#### Scenario: Records are never merged

- **WHEN** the same Discord account is synced from two servers
- **THEN** neither record overwrites the other
- **AND** neither sync run treats the other server's record as stale

### Requirement: Uniqueness is enforced within a server, not across servers

The directory SHALL enforce that a Discord account appears at most once within a server, and that a normalized Discord handle appears at most once within a server. It SHALL NOT enforce either uniqueness across servers.

#### Scenario: The same account twice in one server is impossible

- **WHEN** a sync attempts to create a second record for an account already stored for that server
- **THEN** the existing record is updated rather than duplicated

#### Scenario: The same account in two servers is allowed

- **WHEN** an account is stored for one server and then synced from a second server
- **THEN** a second record is created rather than the write being rejected as a duplicate

#### Scenario: The same handle in two servers is allowed

- **WHEN** the same normalized handle exists in two servers
- **THEN** both records are stored, because a Discord handle identifies one account and two such records are that one person in two places

### Requirement: Membership state, departure, and handle repair are per server

Departure flagging, rejoining, and the repair of a handle reclaimed by another account SHALL apply only within the server they occurred in, and SHALL leave every other server's records untouched.

#### Scenario: Leaving one server

- **WHEN** a member leaves one configured server while remaining in another
- **THEN** only that server's record is flagged as departed with its departure time
- **AND** the other server's record continues to show them as present

#### Scenario: Rejoining one server

- **WHEN** a member rejoins a server they had left
- **THEN** that server's record is reactivated and its departure time cleared
- **AND** no other server's record is modified

#### Scenario: A handle reclaimed within one server

- **WHEN** a member renames onto a handle another record in the same server still holds
- **THEN** only the stale record in that same server is repaired
- **AND** a record holding the same handle in a different server is left alone, because it is a different server's membership and not a conflict

### Requirement: Attendance and daily-update history belongs to a server through its member record

Every attendance record, daily-update record, and reminder recipient record SHALL be owned by exactly one member record and therefore by exactly one server. Determining which server a record belongs to SHALL NOT require a second stored copy of the server identifier on those records.

#### Scenario: Attendance is attributed to a server

- **WHEN** an attendance record is stored
- **THEN** the server it belongs to is the server of the member record that owns it

#### Scenario: One person's history in two servers stays separately owned

- **WHEN** a person who is in two servers has attendance in both
- **THEN** each record is distinct and owned by its own server's member record
- **AND** neither record is rewritten or absorbed by the other server's

Ownership is not the same as credit: which server a record belongs to is settled here, while whether that record satisfies the person's day everywhere is settled by "One Discord account is one person, and one person owes one day's work" below.

#### Scenario: History survives a departure from one server

- **WHEN** a member departs one server
- **THEN** their records in that server keep a valid owner and remain readable
- **AND** their records in the other server are unaffected

### Requirement: A handle resolves to every server the account is currently active in

Resolving a normalized Discord handle SHALL return the set of servers in which that handle currently belongs to a present member, which may be empty, one, or several. A caller that needs one server SHALL choose from that set explicitly rather than relying on an arbitrary first match.

#### Scenario: Handle belongs to one server

- **WHEN** a handle is resolved and the account is present in one configured server
- **THEN** that one server's member record is returned

#### Scenario: Handle belongs to both servers

- **WHEN** a handle is resolved and the account is present in two configured servers
- **THEN** both member records are returned

#### Scenario: Handle belongs to no server

- **WHEN** a handle is unknown, or belongs only to records marked as departed
- **THEN** an empty set is returned
- **AND** the two cases remain indistinguishable to the caller, so the lookup cannot be used to learn that someone used to be in a server

#### Scenario: Departed records are excluded per server

- **WHEN** an account is departed from one server and present in another
- **THEN** only the server they are present in is returned

### Requirement: One Discord account is one person, and one person owes one day's work

A Discord account SHALL be treated as a single person regardless of how many configured servers hold a record for it. Work recorded against any one of that account's member records SHALL satisfy the day for the account everywhere. The system SHALL NOT require the same person to submit the same thing once per server, and SHALL NOT report them as missing in one server on account of having done the work in another.

This is a statement about obligations, not about storage: the per-server records above are unchanged, and each still owns its own membership state and its own history.

#### Scenario: A daily update posted in one server satisfies the day

- **WHEN** an account is a current member of two configured servers and posts a daily update in one of them
- **THEN** the account is reported as having submitted a daily update, in both servers
- **AND** it is not reported as missing an update in the server it did not post in

#### Scenario: Attendance submitted before joining the second server

- **WHEN** an account submits the attendance form, and afterwards joins a second configured server on the same day
- **THEN** the account is reported as having submitted attendance in the second server too
- **AND** no second submission is required of them

#### Scenario: A person who did nothing anywhere is still missing

- **WHEN** an account is a current member of two configured servers and posts no update in either
- **THEN** it is reported as missing an update

#### Scenario: A single-server account is unaffected

- **WHEN** an account belongs to exactly one configured server
- **THEN** its status is derived exactly as it would be with one server configured

#### Scenario: The credit is not narrowed by a server filter

- **WHEN** a report is narrowed to one configured server and a listed account posted its update in a different server
- **THEN** the account is still reported as having submitted
- **AND** narrowing the view changes which people are listed, never whether a listed person has done the work

#### Scenario: Departure does not withdraw credit

- **WHEN** an account posts an update in one server and later leaves that server, while remaining in another
- **THEN** the update still counts for the day
- **AND** the record in the server they left is excluded from the report as departed records always are

### Requirement: A person appears once in reports, carrying the servers they belong to

A report over member status SHALL list each Discord account at most once for a given date, and SHALL name the configured servers that account belongs to on that single entry. It SHALL also report how many configured servers hold the account in total, so a report narrowed to one server can still show that the person is elsewhere as well.

Per-server breakdowns SHALL remain available and SHALL count memberships rather than accounts, so each server keeps a denominator it can act on. The combined figures and the per-server breakdown therefore need not sum to one another, and the difference between them is the overlap.

#### Scenario: A person in two servers is one entry

- **WHEN** an account is a current member of two configured servers and no server filter is applied
- **THEN** exactly one entry is returned for that account
- **AND** the entry names both servers
- **AND** the entry reports a server count of two

#### Scenario: The combined total counts people

- **WHEN** combined figures are produced with no server filter
- **THEN** an account in two servers contributes one to the total
- **AND** the status buckets still sum to the total

#### Scenario: The per-server breakdown counts memberships

- **WHEN** a per-server breakdown is produced alongside the combined figures
- **THEN** an account in two servers contributes one to each server's total
- **AND** the breakdown is not expected to sum to the combined total

#### Scenario: A server filter narrows who is listed, once each

- **WHEN** a report is narrowed to one configured server
- **THEN** only accounts holding a record in that server are listed
- **AND** each such account appears exactly once
- **AND** the servers named on the entry are narrowed to the filtered server while the reported server count still reflects every server holding the account

#### Scenario: Overlap is visible without duplication

- **WHEN** an account is present in two servers
- **THEN** the fact is reported as a property of its single entry
- **AND** it is not conveyed by returning the account twice