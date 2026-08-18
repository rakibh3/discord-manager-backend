## MODIFIED Requirements

### Requirement: Discord members are stored separately from admin accounts

The system SHALL persist guild members in a dedicated `discord_members` table. The existing `users` table SHALL continue to represent administrator login accounts only, and no Discord data is written to it.

#### Scenario: Member record shape

- **WHEN** a guild member is persisted
- **THEN** the record stores the configured server it belongs to, the Discord snowflake user ID, the normalized username, the display name, the avatar URL, and guild-membership state
- **AND** the snowflake ID and the normalized username are each unique within that server, not across servers

#### Scenario: Admin accounts untouched

- **WHEN** member sync runs
- **THEN** no row in the `users` table is created, updated, or deleted

### Requirement: Full member sync runs when the bot becomes ready

The system SHALL fetch the complete member list of **every** configured server once the client is ready and reconcile each into the database independently. Bot accounts SHALL be excluded. Each server's sync SHALL read and write only that server's records.

#### Scenario: Initial sync populates the directory for every server

- **WHEN** the bot becomes ready and the configured servers are reachable
- **THEN** every non-bot member of each server is upserted into `discord_members` under that server, with normalized username, display name, and avatar URL

#### Scenario: One server unreachable at sync time

- **WHEN** one configured server cannot be fetched
- **THEN** it is logged with the reason and skipped
- **AND** the remaining servers are still synced

#### Scenario: Bot accounts skipped

- **WHEN** the fetched member list contains accounts flagged as bots
- **THEN** those members are not written to the database

#### Scenario: Existing member is refreshed

- **WHEN** a member already stored for that server has since changed their display name or avatar
- **THEN** that server's existing row is updated in place rather than duplicated
- **AND** the same account's row in another server is not modified

#### Scenario: Sync does not block the API

- **WHEN** the full sync of roughly 5,000 members per server is in progress
- **THEN** the HTTP server continues to accept and answer requests throughout

#### Scenario: Individual member fails to process

- **WHEN** one member cannot be persisted, for example because their username fails validation
- **THEN** the failure is logged with that member's ID and the sync continues with the remaining members
- **AND** the final summary reports the number of failures

#### Scenario: Concurrent sync prevented per server

- **WHEN** a sync is requested for a server whose sync is already running
- **THEN** the second request for that server is rejected rather than run in parallel
- **AND** a sync of a different server is not blocked by it

### Requirement: Departed members are marked, never deleted

The system SHALL preserve historical member rows so past attendance and daily-update records keep a valid owner. Members no longer in a server SHALL be flagged instead of removed, and the flagging SHALL apply only to records of the server being reconciled.

#### Scenario: Member absent from full sync

- **WHEN** a stored member of the server being synced does not appear in that server's freshly fetched member list
- **THEN** their row is marked as no longer in the guild with the time of departure recorded
- **AND** the row itself is not deleted

#### Scenario: Records of other servers are never touched

- **WHEN** one server's departure reconcile runs
- **THEN** no record belonging to any other configured server is read as part of its baseline or modified by it

#### Scenario: Member rejoins

- **WHEN** a previously departed member is seen again in that server
- **THEN** their existing row for that server is reactivated and its departure timestamp is cleared

### Requirement: Member directory stays current through gateway events

The system SHALL listen for member lifecycle events so the directory reflects each configured server between full syncs. Every such event SHALL be attributed to the configured server it originated in, and SHALL be ignored when it originates in a server that is not configured. The directory SHALL additionally be repaired on demand from any gateway event that identifies a guild member, including a message posted in a daily-update channel, so that a member who is not yet recorded is added rather than causing the event to be dropped.

#### Scenario: Member joins

- **WHEN** a non-bot user joins a configured server
- **THEN** their member record for that server is created or reactivated immediately

#### Scenario: Member leaves

- **WHEN** a user leaves or is removed from a configured server
- **THEN** their record for that server is marked as no longer in the guild
- **AND** their record for any other configured server is unchanged

#### Scenario: Event from an unconfigured server

- **WHEN** a member event arrives from a guild that is not in the configured list
- **THEN** it is ignored and nothing is written

#### Scenario: Username changes

- **WHEN** a tracked user changes their account username
- **THEN** the stored normalized username is updated in every configured server that holds a record for that account

#### Scenario: Display name or avatar changes

- **WHEN** a tracked member changes their server nickname or avatar
- **THEN** the stored display name and avatar URL for that server's record are updated
- **AND** the normalized username is left unchanged
- **AND** another server's record for the same account keeps its own display name

#### Scenario: Event for an unknown member

- **WHEN** an update event arrives for a user who has no stored record in that server
- **THEN** a record is created for that server from the event payload rather than the event being dropped

#### Scenario: Message received from an unrecorded member

- **WHEN** a message arrives in a configured daily-update channel from a non-bot author who has no stored member record in that server
- **THEN** the member is fetched from that server and written to the directory through the same upsert path as member sync
- **AND** the resulting record is indistinguishable from one written by a member event or a full sync

#### Scenario: Directory repair reuses the shared upsert path

- **WHEN** any caller outside `src/lib/discord/` needs to record a member seen at runtime
- **THEN** it uses the shared member upsert, passing the server the member was seen in, rather than writing `discord_members` directly, so username-collision handling and reactivation behave identically

### Requirement: Sync status is observable and re-runnable by admins

The system SHALL expose the outcome of the most recent sync **per configured server** and allow an authenticated administrator to trigger a fresh sync of every server or of one named server.

#### Scenario: Reading sync status

- **WHEN** an authenticated `ADMIN` calls the sync status endpoint
- **THEN** the response reports whether the bot is connected, and for each configured server its identifier, its label, whether it is reachable, its total and active member counts, and the timestamp, duration, and result of its last sync

#### Scenario: Manual re-sync of every server

- **WHEN** an authenticated `ADMIN` triggers a manual sync without naming a server
- **THEN** a full sync starts for every configured server and the response confirms which were accepted

#### Scenario: Manual re-sync of one server

- **WHEN** an authenticated `ADMIN` triggers a manual sync naming one configured server
- **THEN** only that server is synced

#### Scenario: Manual re-sync naming an unconfigured server

- **WHEN** the named server is not in the configured list
- **THEN** the request is refused naming the unknown server, rather than silently syncing everything

#### Scenario: Unauthenticated access

- **WHEN** a request without a valid admin access token hits either endpoint
- **THEN** the request is rejected as unauthorized

#### Scenario: Manual re-sync while bot is offline

- **WHEN** an admin triggers a sync while the Discord client is not connected
- **THEN** the request fails with an error explaining the bot is not connected

## ADDED Requirements

### Requirement: The departure guard is evaluated within one server

The system SHALL refuse to mark members as departed from a member list that looks truncated, and SHALL evaluate that judgement against the stored active count **of the server being synced alone**. The reconcile that follows SHALL be restricted to that server's records.

#### Scenario: Guard compares against the same server

- **WHEN** a server's fetch returns no non-bot members, or fewer than half the members currently stored as active **for that server**
- **THEN** the departure reconcile for that server is skipped and logged loudly
- **AND** the skipped state is reported through the sync status endpoint for that server

#### Scenario: A small server is not judged against a large one

- **WHEN** one configured server has far fewer members than another
- **THEN** its guard uses its own stored active count as the baseline
- **AND** a healthy fetch is not mistaken for a truncated one because another server is larger

#### Scenario: A truncated fetch cannot affect another server

- **WHEN** one server's fetch is truncated and its reconcile is skipped
- **THEN** no member of any other configured server is marked as departed
- **AND** the other servers' syncs proceed normally

#### Scenario: Reconcile is scoped even when the guard passes

- **WHEN** a server's departure reconcile runs normally
- **THEN** only records belonging to that server are eligible to be marked departed
- **AND** members of another server who are absent from this server's fetch are unaffected, because they were never expected to appear in it

### Requirement: Username collision repair is scoped to one server

The system SHALL repair a normalized handle that a different stored record in the **same** server still holds, and SHALL leave records in other servers that hold the same handle untouched.

#### Scenario: Collision within a server

- **WHEN** a member renames onto a handle another record in the same server still holds
- **THEN** the stale record in that server is tombstoned so it can never match a normalized lookup
- **AND** the renaming member's record is then written successfully

#### Scenario: Same handle in another server is not a collision

- **WHEN** a handle being written for one server already exists on a record in a different server
- **THEN** no repair is performed, because the two records are the same person in two servers

#### Scenario: Collision detection survives the driver adapter

- **WHEN** a uniqueness violation on the handle is raised through the configured database driver adapter
- **THEN** it is recognised as a handle collision and the repair runs
- **AND** detection does not depend on a field the adapter leaves unpopulated
