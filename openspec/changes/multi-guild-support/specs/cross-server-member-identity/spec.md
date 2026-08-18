## ADDED Requirements

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

#### Scenario: One person's history in two servers stays separate

- **WHEN** a person who is in two servers has attendance in both
- **THEN** each server's record is distinct and reported under its own server
- **AND** neither server's report includes the other server's record

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

### Requirement: Accounts present in more than one server are visible as such

The system SHALL make it possible to see that a directory record's Discord account is also present in another configured server, without merging the records. This SHALL be reported as a property of the record rather than by de-duplicating rows.

#### Scenario: Overlap is reported on a status row

- **WHEN** a member status row is returned for an account that is present in two servers
- **THEN** the row indicates that the account is present in more than one server

#### Scenario: No overlap

- **WHEN** the account is present in only the server being reported
- **THEN** the row indicates a single server

#### Scenario: Overlap does not change the counts

- **WHEN** an account is present in two servers and is counted in each server's figures
- **THEN** each server's totals include them once, because they owe that server's daily obligations independently
- **AND** the overlap indicator is what explains the apparent duplication rather than the counts being adjusted
