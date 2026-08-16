# discord-member-sync Specification

## Purpose

Defines the synced guild member directory (`discord_members`) that future attendance and daily-update records hang off. It covers Discord username validation and normalization, the separation between synced members and admin login accounts, the full sync that runs when the bot becomes ready, the gateway events that keep the directory current between syncs, and the admin-facing status and manual re-sync endpoints. Departed members are always flagged, never deleted, so historical records keep a valid owner.

## Requirements

### Requirement: Discord usernames follow the official standard

The system SHALL validate Discord usernames against the official Pomelo username rules and SHALL normalize every username before it is stored or compared. Normalization trims surrounding whitespace, strips leading `@` characters, and lowercases the result.

#### Scenario: Valid username accepted

- **WHEN** a username such as `rakib_dev`, `a.b`, or `user.name_1` is validated
- **THEN** it is accepted as a well-formed Discord username

#### Scenario: Leading or trailing underscore and period accepted

- **WHEN** a username begins or ends with `_` or `.`, such as `itzazad_`, `.rabbil`, or `shahriarratul.`
- **THEN** it is accepted, because Discord permits those handles and real guild members hold them
- **AND** validation never rejects a username pattern that a current guild member actually uses

#### Scenario: Input is normalized before use

- **WHEN** the raw input is `  @Rakib_Dev  `
- **THEN** the normalized form is `rakib_dev`
- **AND** that normalized form is what gets stored and compared

#### Scenario: Malformed usernames rejected

- **WHEN** a username is shorter than 2 or longer than 32 characters, contains a character outside `a-z`, `0-9`, `_`, and `.`, contains consecutive periods, contains a space, or carries a legacy `#0000` discriminator
- **THEN** validation rejects it

#### Scenario: Display name is not a username

- **WHEN** a member's server display name differs from their account username
- **THEN** only the account username is stored in the normalized username field
- **AND** the display name is stored separately as non-identifying data

### Requirement: Discord members are stored separately from admin accounts

The system SHALL persist guild members in a dedicated `discord_members` table. The existing `users` table SHALL continue to represent administrator login accounts only, and no Discord data is written to it.

#### Scenario: Member record shape

- **WHEN** a guild member is persisted
- **THEN** the record stores the Discord snowflake user ID, the normalized username, the display name, the avatar URL, and guild-membership state
- **AND** both the snowflake ID and the normalized username are unique

#### Scenario: Admin accounts untouched

- **WHEN** member sync runs
- **THEN** no row in the `users` table is created, updated, or deleted

### Requirement: Full member sync runs when the bot becomes ready

The system SHALL fetch the complete guild member list once the client is ready and reconcile it into the database. Bot accounts SHALL be excluded.

#### Scenario: Initial sync populates the directory

- **WHEN** the bot becomes ready and the guild is reachable
- **THEN** every non-bot guild member is upserted into `discord_members` with normalized username, display name, and avatar URL

#### Scenario: Bot accounts skipped

- **WHEN** the fetched member list contains accounts flagged as bots
- **THEN** those members are not written to the database

#### Scenario: Existing member is refreshed

- **WHEN** a member already stored has since changed their display name or avatar
- **THEN** the existing row is updated in place rather than duplicated

#### Scenario: Sync does not block the API

- **WHEN** the full sync of roughly 5,000 members is in progress
- **THEN** the HTTP server continues to accept and answer requests throughout

#### Scenario: Individual member fails to process

- **WHEN** one member cannot be persisted, for example because their username fails validation
- **THEN** the failure is logged with that member's ID and the sync continues with the remaining members
- **AND** the final summary reports the number of failures

#### Scenario: Concurrent sync prevented

- **WHEN** a sync is requested while another sync is already running
- **THEN** the second request is rejected rather than run in parallel

### Requirement: Departed members are marked, never deleted

The system SHALL preserve historical member rows so past attendance and daily-update records keep a valid owner. Members no longer in the guild SHALL be flagged instead of removed.

#### Scenario: Member absent from full sync

- **WHEN** a stored member does not appear in the freshly fetched guild member list
- **THEN** their row is marked as no longer in the guild with the time of departure recorded
- **AND** the row itself is not deleted

#### Scenario: Member rejoins

- **WHEN** a previously departed member is seen again in the guild
- **THEN** their existing row is reactivated and its departure timestamp is cleared

### Requirement: Member directory stays current through gateway events

The system SHALL listen for member lifecycle events so the directory reflects the guild between full syncs. The directory SHALL additionally be repaired on demand from any gateway event that identifies a guild member, including a message posted in the daily-update channel, so that a member who is not yet recorded is added rather than causing the event to be dropped.

#### Scenario: Member joins

- **WHEN** a non-bot user joins the guild
- **THEN** their member record is created or reactivated immediately

#### Scenario: Member leaves

- **WHEN** a user leaves or is removed from the guild
- **THEN** their record is marked as no longer in the guild

#### Scenario: Username changes

- **WHEN** a tracked user changes their account username
- **THEN** the stored normalized username is updated to the new value

#### Scenario: Display name or avatar changes

- **WHEN** a tracked member changes their server nickname or avatar
- **THEN** the stored display name and avatar URL are updated
- **AND** the normalized username is left unchanged

#### Scenario: Event for an unknown member

- **WHEN** an update event arrives for a user who has no stored record
- **THEN** a record is created from the event payload rather than the event being dropped

#### Scenario: Message received from an unrecorded member

- **WHEN** a message arrives in the daily-update channel from a non-bot author who has no stored member record
- **THEN** the member is fetched and written to the directory through the same upsert path as member sync
- **AND** the resulting record is indistinguishable from one written by a member event or a full sync

#### Scenario: Directory repair reuses the shared upsert path

- **WHEN** any caller outside `src/lib/discord/` needs to record a member seen at runtime
- **THEN** it uses the shared member upsert rather than writing `discord_members` directly, so username-collision handling and reactivation behave identically

### Requirement: Sync status is observable and re-runnable by admins

The system SHALL expose the outcome of the most recent sync and allow an authenticated administrator to trigger a fresh one.

#### Scenario: Reading sync status

- **WHEN** an authenticated `ADMIN` calls the sync status endpoint
- **THEN** the response reports whether the bot is connected, the total and active member counts, and the timestamp, duration, and result of the last sync

#### Scenario: Manual re-sync

- **WHEN** an authenticated `ADMIN` triggers a manual sync
- **THEN** a full sync starts and the response confirms it was accepted

#### Scenario: Unauthenticated access

- **WHEN** a request without a valid admin access token hits either endpoint
- **THEN** the request is rejected as unauthorized

#### Scenario: Manual re-sync while bot is offline

- **WHEN** an admin triggers a sync while the Discord client is not connected
- **THEN** the request fails with an error explaining the bot is not connected
