## MODIFIED Requirements

### Requirement: Bot client is created with the required gateway intents

The system SHALL create a single shared `discord.js` `Client` configured with the `Guilds`, `GuildMembers`, `GuildMessages`, and `MessageContent` gateway intents. `Guilds` and `GuildMembers` are the minimum needed to enumerate and track guild members; `GuildMessages` and `MessageContent` are the minimum needed to receive and read `#daily-update` posts. `GuildMembers` and `MessageContent` are both privileged and must be enabled in the Developer Portal.

#### Scenario: Client construction

- **WHEN** the bot client is created
- **THEN** its intents include `GatewayIntentBits.Guilds`, `GatewayIntentBits.GuildMembers`, `GatewayIntentBits.GuildMessages`, and `GatewayIntentBits.MessageContent`

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

- **WHEN** login fails because a privileged gateway intent is disabled in the Developer Portal
- **THEN** the logged error names the specific Developer Portal toggles to enable
- **AND** the system attempts the degraded-mode recovery described under "A missing Message Content intent degrades ingestion, not member sync"

#### Scenario: Runtime gateway error

- **WHEN** the client emits an `error` or `shardError` event after startup
- **THEN** the error is logged and the process does not exit, allowing discord.js to reconnect

## ADDED Requirements

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
