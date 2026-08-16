## MODIFIED Requirements

### Requirement: Bot lifecycle is isolated from the HTTP server

The system SHALL start the bot alongside the Express server in the same process, and a Discord failure SHALL NOT prevent the API from serving traffic. The channel scheduler SHALL be started in that same process after the bot, and SHALL be isolated in both directions: a scheduler failure SHALL NOT stop the HTTP server or the gateway connection, and a bot failure SHALL NOT prevent the process from starting.

#### Scenario: Successful startup

- **WHEN** the process starts and the database connection succeeds
- **THEN** the HTTP server begins listening
- **AND** the bot logs in and reports the authenticated bot tag once ready
- **AND** the channel scheduler is started once the bot is ready

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

#### Scenario: Bot never connects

- **WHEN** the bot fails to log in
- **THEN** the scheduler does not attempt channel operations against a disconnected client, and reports itself as unable to act rather than failing repeatedly in silence

### Requirement: Bot shuts down gracefully

The system SHALL destroy the Discord client, stop the channel scheduler, and disconnect Prisma when the process receives a termination signal.

#### Scenario: SIGTERM received

- **WHEN** the process receives `SIGINT` or `SIGTERM`
- **THEN** the HTTP server stops accepting new connections
- **AND** the scheduler's timed jobs are stopped so no job fires during shutdown
- **AND** the Discord client is destroyed
- **AND** the Prisma connection is closed before the process exits

## ADDED Requirements

### Requirement: Channel permission management is an operational prerequisite

The bot SHALL require the Manage Roles permission on the daily-update channel in order to edit its `@everyone` permission overwrite. The system SHALL surface a permission failure to administrators rather than only logging it, because a bot that cannot edit the overwrite leaves the submission window unenforced with no other visible symptom.

#### Scenario: Permission missing when a channel operation runs

- **WHEN** a channel open or lock is rejected by Discord for missing permissions
- **THEN** the error is logged naming the required permission and the channel
- **AND** it is reported through the administrator-facing scheduler status

#### Scenario: Permission granted

- **WHEN** the bot holds Manage Roles on the channel
- **THEN** open and lock operations succeed and report no error
