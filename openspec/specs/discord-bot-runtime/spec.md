# discord-bot-runtime Specification

## Purpose

Defines how the Discord gateway client is configured, started, supervised, and shut down inside the same process as the Express API. The governing constraint is isolation: Discord configuration is validated up front, and any Discord failure — bad token, disabled privileged intent, unreachable guild, runtime gateway error — is logged rather than thrown, so the HTTP API keeps serving traffic.

Isolation extends to the bot's own features. A privileged intent that only message ingestion needs must not be able to take down member sync, because the student-facing attendance form depends on the member directory. Degradation is therefore partial and reported, never silent.

The bot connects once with a single token and a single gateway client that covers every configured server. Every code path that needs a server obtains it from the configured server list or from the event being handled, never from a stored single-guild variable.

The process hosts two further subsystems alongside Express and the gateway client: the channel scheduler and the reminder DM queue worker. Both start only once the bot is ready, and both stop before the client is destroyed — the worker so that no delivery is sent into a closing connection. Each is isolated in every direction: neither may take down the bot, the API, or the other.

## Requirements

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

### Requirement: Bot client is created with the required gateway intents

The system SHALL create a single shared `discord.js` `Client` configured with the `Guilds`, `GuildMembers`, `GuildMessages`, and `MessageContent` gateway intents. `Guilds` and `GuildMembers` are the minimum needed to enumerate and track guild members; `GuildMessages` and `MessageContent` are the minimum needed to receive and read `#daily-update` posts. `GuildMembers` and `MessageContent` are both privileged and must be enabled in the Developer Portal.

#### Scenario: Client construction

- **WHEN** the bot client is created
- **THEN** its intents include `GatewayIntentBits.Guilds`, `GatewayIntentBits.GuildMembers`, `GatewayIntentBits.GuildMessages`, and `GatewayIntentBits.MessageContent`

#### Scenario: Single shared instance

- **WHEN** any part of the application imports the Discord client
- **THEN** it receives the same client instance rather than constructing a new one

### Requirement: Bot lifecycle is isolated from the HTTP server

The system SHALL start the bot alongside the Express server in the same process, and a Discord failure SHALL NOT prevent the API from serving traffic. The channel scheduler and the reminder queue worker SHALL be started in that same process after the bot, and each SHALL be isolated in every direction: a failure in the scheduler or the worker SHALL NOT stop the HTTP server, the gateway connection, or each other, and a bot failure SHALL NOT prevent the process from starting.

#### Scenario: Successful startup

- **WHEN** the process starts and the database connection succeeds
- **THEN** the HTTP server begins listening
- **AND** the bot logs in and reports the authenticated bot tag once ready
- **AND** the channel scheduler is started once the bot is ready
- **AND** the reminder queue worker is started once the bot is ready

#### Scenario: Login fails

- **WHEN** `client.login()` rejects because the token is invalid or Discord is unreachable
- **THEN** the error is logged with its cause
- **AND** the process stays alive and the HTTP API continues to respond

#### Scenario: Privileged intent not enabled

- **WHEN** login fails because a privileged gateway intent is disabled in the Developer Portal
- **THEN** the logged error names the specific Developer Portal toggles to enable
- **AND** the system attempts the degraded-mode recovery described under "A missing Message Content intent degrades ingestion, not member sync"

#### Scenario: Runtime gateway error

- **WHEN** the client emits an `error` or `shardError` event after startup
- **THEN** the error is logged and the process does not exit, allowing discord.js to reconnect

#### Scenario: Scheduler start fails

- **WHEN** starting the channel scheduler throws, for example because its configuration cannot be read
- **THEN** the error is logged
- **AND** the HTTP server keeps serving and the gateway connection is unaffected

#### Scenario: Queue worker start fails

- **WHEN** starting the reminder queue worker fails, for example because its datastore is unreachable
- **THEN** the error is logged
- **AND** the HTTP server, the gateway connection, message ingestion, and the channel scheduler are unaffected

#### Scenario: Bot never connects

- **WHEN** the bot fails to log in
- **THEN** the scheduler does not attempt channel operations against a disconnected client, and reports itself as unable to act rather than failing repeatedly in silence
- **AND** the queue worker is not started, so no job is consumed and failed against a disconnected client

### Requirement: A missing Message Content intent degrades ingestion, not member sync

Discord rejects a login outright when it requests a privileged intent that is not enabled, so requesting `MessageContent` puts member sync — and with it the attendance form's membership check — at the mercy of one Developer Portal toggle. The system SHALL therefore, when login is rejected for disallowed intents, retry once without `MessageContent`, keeping member sync and the HTTP API fully functional while daily-update ingestion is disabled.

#### Scenario: Message Content intent disabled in the portal

- **WHEN** the first login attempt is rejected with a disallowed-intents error
- **THEN** an error is logged instructing the operator to enable the Message Content Intent in the Discord Developer Portal
- **AND** the client is recreated or reconfigured without `MessageContent` and login is retried exactly once

#### Scenario: Retry succeeds

- **WHEN** the retry without `MessageContent` logs in successfully
- **THEN** member sync and all gateway member events run normally
- **AND** the `messageCreate` ingestion listener is not registered
- **AND** a warning states plainly that daily-update ingestion is disabled until the intent is enabled

#### Scenario: Retry also fails

- **WHEN** the retry without `MessageContent` is also rejected
- **THEN** the failure is logged with the likely cause being the Server Members Intent
- **AND** the bot does not run, while the HTTP API continues to serve requests

#### Scenario: No infinite retry

- **WHEN** the degraded retry has been attempted
- **THEN** no further automatic login attempts are made for the same failure

### Requirement: Ingestion availability is observable

The system SHALL expose whether daily-update ingestion is active, so that a silently degraded bot is detectable without reading process logs.

#### Scenario: Status reported while fully operational

- **WHEN** an administrator reads the Discord bot status endpoint and the bot logged in with `MessageContent`
- **THEN** the response reports daily-update ingestion as enabled

#### Scenario: Status reported while degraded

- **WHEN** the bot is running after the fallback login without `MessageContent`
- **THEN** the response reports daily-update ingestion as disabled, along with the reason

### Requirement: Bot shuts down gracefully

The system SHALL close the reminder queue worker, destroy the Discord client, stop the channel scheduler, and disconnect Prisma when the process receives a termination signal. The worker SHALL be closed before the client is destroyed, so no delivery is sent into a closing connection.

#### Scenario: SIGTERM received

- **WHEN** the process receives `SIGINT` or `SIGTERM`
- **THEN** the HTTP server stops accepting new connections
- **AND** the scheduler's timed jobs are stopped so no job fires during shutdown
- **AND** the reminder queue worker is closed, allowing a delivery in flight to finish, before the Discord client is destroyed
- **AND** the Discord client is destroyed
- **AND** the Prisma connection is closed before the process exits

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
