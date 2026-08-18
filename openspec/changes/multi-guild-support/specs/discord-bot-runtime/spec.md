## MODIFIED Requirements

### Requirement: Discord configuration is validated at startup

The system SHALL read all Discord settings from environment variables and validate them before the bot attempts to log in. It SHALL read the configured servers as a list, each server carrying its own attendance, daily-update, and reminder channel identifiers, and SHALL validate the lists against one another as well as individually. Channel and guild identifiers SHALL never be derived from channel names.

#### Scenario: All required variables present

- **WHEN** the process starts with `DISCORD_BOT_TOKEN` set and matching lists of guild, attendance, daily-update, and reminder channel identifiers
- **THEN** the configuration is exposed as a typed list of servers on the shared config and the bot proceeds to log in

#### Scenario: Single-server configuration still valid

- **WHEN** the process starts with the singular `DISCORD_GUILD_ID`, `ATTENDANCE_CHANNEL_ID`, `DAILY_UPDATE_CHANNEL_ID`, and `REMINDER_CHANNEL_ID` variables
- **THEN** they are accepted as a one-server list and the bot proceeds to log in

#### Scenario: Required variable missing

- **WHEN** `DISCORD_BOT_TOKEN` is absent or empty, or no guild identifier is configured at all
- **THEN** startup logs an error naming the specific missing variable
- **AND** the bot does not attempt to log in
- **AND** the HTTP API still starts and serves requests

#### Scenario: Identifier is not a snowflake

- **WHEN** any configured guild or channel ID is not a numeric string of 17 to 20 digits
- **THEN** validation fails for that variable and reports its name and its position in the list

#### Scenario: Server lists do not line up

- **WHEN** the configured lists of guild and channel identifiers are of different lengths, a guild identifier is repeated, or one channel identifier appears under two servers
- **THEN** validation fails naming the offending variables
- **AND** the bot does not attempt to log in
- **AND** the HTTP API still starts and serves requests

### Requirement: Configured guild is verified on ready

The system SHALL confirm, once the client is ready, which of the configured servers the bot is actually a member of, before any sync work runs for them. A server the bot cannot reach SHALL be reported and skipped, and SHALL NOT prevent the reachable servers from being used.

#### Scenario: Every configured guild reachable

- **WHEN** the client becomes ready
- **THEN** each configured guild is fetched successfully and its name and member count are logged
- **AND** each is eligible for sync, scheduling, announcements, and broadcasts

#### Scenario: One configured guild unreachable

- **WHEN** fetching one configured guild fails because the bot was never invited or the ID is wrong
- **THEN** an error is logged identifying that guild ID
- **AND** member sync for that server is skipped rather than run against a partial state
- **AND** the remaining configured servers proceed normally

#### Scenario: No configured guild reachable

- **WHEN** none of the configured guilds can be fetched
- **THEN** every one of them is logged with its reason
- **AND** the HTTP API continues to serve requests

#### Scenario: Reachability is observable

- **WHEN** an administrator reads the Discord status endpoint
- **THEN** each configured server is listed with whether the bot is currently a member of it

### Requirement: Channel permission management is an operational prerequisite

The bot SHALL require, **in every configured server**, the Manage Roles permission on that server's daily-update channel in order to edit its `@everyone` permission overwrite, the Send Messages permission on that server's reminder channel in order to post the closed-DM fallback announcement, and the Send Messages permission on that server's attendance channel in order to post the announcement. The system SHALL surface a permission failure to administrators **naming the server it occurred in**, rather than only logging it, because in each case the bot keeps running and the only other symptom is something that silently never happens.

#### Scenario: Permission missing when a channel operation runs

- **WHEN** a channel open or lock is rejected by Discord for missing permissions in one server
- **THEN** the error is logged naming the required permission, the channel, and the server
- **AND** it is reported through the administrator-facing scheduler status against that server
- **AND** the other configured servers' channel operations are unaffected

#### Scenario: Permission granted

- **WHEN** the bot holds Manage Roles on a server's channel
- **THEN** open and lock operations succeed for that server and report no error

#### Scenario: Permission missing on the reminder channel

- **WHEN** the fallback announcement is rejected by Discord for missing permissions in one server
- **THEN** the error is logged naming the required permission, the reminder channel, and the server
- **AND** it is reported through the administrator-facing reminder status
- **AND** the reminder DMs that were already delivered are unaffected
- **AND** the fallback announcement in other servers still posts

#### Scenario: A permission gap in one server is not reported as a global failure

- **WHEN** exactly one configured server is missing a required permission
- **THEN** the status reads show that server as failing and the others as healthy

## ADDED Requirements

### Requirement: Gateway events are routed by the configured server they came from

The system SHALL determine, for every gateway event carrying a guild, which configured server it belongs to, and SHALL dispatch it with that server's configuration. An event from a guild that is not configured SHALL be ignored.

#### Scenario: Event from a configured server

- **WHEN** a member or message event arrives from a configured guild
- **THEN** it is handled using that server's channel identifiers and written against that server's records

#### Scenario: Event from an unconfigured server

- **WHEN** an event arrives from a guild that is not in the configured list
- **THEN** it is ignored and nothing is written

#### Scenario: No code path names a single guild

- **WHEN** any handler, scheduler, repository, or service needs a server
- **THEN** it obtains it from the configured server list or from the event being handled
- **AND** no code path reads a single configured guild identifier as though it were the only one
