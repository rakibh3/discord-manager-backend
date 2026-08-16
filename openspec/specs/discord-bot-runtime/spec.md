# discord-bot-runtime Specification

## Purpose

Defines how the Discord gateway client is configured, started, supervised, and shut down inside the same process as the Express API. The governing constraint is isolation: Discord configuration is validated up front, and any Discord failure — bad token, disabled privileged intent, unreachable guild, runtime gateway error — is logged rather than thrown, so the HTTP API keeps serving traffic.

## Requirements

### Requirement: Discord configuration is validated at startup

The system SHALL read all Discord settings from environment variables and validate them before the bot attempts to log in. Channel and guild identifiers SHALL never be derived from channel names.

#### Scenario: All required variables present

- **WHEN** the process starts with `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ATTENDANCE_CHANNEL_ID`, `DAILY_UPDATE_CHANNEL_ID`, and `REMINDER_CHANNEL_ID` set
- **THEN** the configuration is exposed as a typed object on the shared config and the bot proceeds to log in

#### Scenario: Required variable missing

- **WHEN** `DISCORD_BOT_TOKEN` or `DISCORD_GUILD_ID` is absent or empty
- **THEN** startup logs an error naming the specific missing variable
- **AND** the bot does not attempt to log in
- **AND** the HTTP API still starts and serves requests

#### Scenario: Identifier is not a snowflake

- **WHEN** any configured guild or channel ID is not a numeric string of 17 to 20 digits
- **THEN** validation fails for that variable and reports its name

### Requirement: Bot client is created with the required gateway intents

The system SHALL create a single shared `discord.js` `Client` configured with the `Guilds` and `GuildMembers` gateway intents, which are the minimum needed to enumerate and track guild members.

#### Scenario: Client construction

- **WHEN** the bot client is created
- **THEN** its intents include `GatewayIntentBits.Guilds` and `GatewayIntentBits.GuildMembers`

#### Scenario: Single shared instance

- **WHEN** any part of the application imports the Discord client
- **THEN** it receives the same client instance rather than constructing a new one

### Requirement: Bot lifecycle is isolated from the HTTP server

The system SHALL start the bot alongside the Express server in the same process, and a Discord failure SHALL NOT prevent the API from serving traffic.

#### Scenario: Successful startup

- **WHEN** the process starts and the database connection succeeds
- **THEN** the HTTP server begins listening
- **AND** the bot logs in and reports the authenticated bot tag once ready

#### Scenario: Login fails

- **WHEN** `client.login()` rejects because the token is invalid or Discord is unreachable
- **THEN** the error is logged with its cause
- **AND** the process stays alive and the HTTP API continues to respond

#### Scenario: Privileged intent not enabled

- **WHEN** login fails because the Server Members privileged intent is disabled in the Developer Portal
- **THEN** the logged error explains that the intent must be enabled in the Discord Developer Portal

#### Scenario: Runtime gateway error

- **WHEN** the client emits an `error` or `shardError` event after startup
- **THEN** the error is logged and the process does not exit, allowing discord.js to reconnect

### Requirement: Bot shuts down gracefully

The system SHALL destroy the Discord client and disconnect Prisma when the process receives a termination signal.

#### Scenario: SIGTERM received

- **WHEN** the process receives `SIGINT` or `SIGTERM`
- **THEN** the HTTP server stops accepting new connections
- **AND** the Discord client is destroyed
- **AND** the Prisma connection is closed before the process exits

### Requirement: Configured guild is verified on ready

The system SHALL confirm the bot is a member of the configured guild before any sync work runs.

#### Scenario: Guild reachable

- **WHEN** the client becomes ready
- **THEN** the guild named by `DISCORD_GUILD_ID` is fetched successfully and its name and member count are logged

#### Scenario: Guild unreachable

- **WHEN** fetching the configured guild fails because the bot was never invited or the ID is wrong
- **THEN** an error is logged identifying the configured guild ID
- **AND** member sync is skipped rather than run against a partial state
