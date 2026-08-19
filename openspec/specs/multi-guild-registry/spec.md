# multi-guild-registry Specification

## Purpose

Defines how the system is configured with one or more Discord servers and how each server's identity, channels, and reachability are validated before any feature runs against them. A deployment with one server SHALL be the one-element case of the same list, not a separate mode.

## Requirements

### Requirement: The system is configured with a list of Discord servers, never a single server

The system SHALL read its Discord servers as a list, and every code path SHALL obtain servers from that list rather than naming a single configured guild. A deployment with one server SHALL be the one-element case of the same list, not a separate mode.

#### Scenario: Two servers configured

- **WHEN** the environment declares two guild IDs with their matching channel IDs
- **THEN** both servers are loaded, each with its own attendance, daily-update, and reminder channel IDs
- **AND** every feature that acts on a server acts on both

#### Scenario: One server configured

- **WHEN** the environment declares a single guild
- **THEN** the system loads a one-element list and behaves exactly as it did before multiple servers were supported

#### Scenario: Legacy single-server variables still boot

- **WHEN** only the singular guild and channel variables from the previous single-server configuration are present
- **THEN** they are accepted as a one-element list
- **AND** startup succeeds without any configuration change

### Requirement: Server configuration is validated as a whole before the bot connects

The system SHALL validate every declared server together at startup, and SHALL refuse to start the bot when the declaration is internally inconsistent. Each declared identifier SHALL be a Discord snowflake. The validation failure message SHALL name the offending variables and what is wrong with them.

#### Scenario: Lists of unequal length

- **WHEN** two guild IDs are declared but only one daily-update channel ID is
- **THEN** startup reports which lists disagree and how many entries each holds
- **AND** the bot does not log in

#### Scenario: A repeated guild ID

- **WHEN** the same guild ID appears twice in the list
- **THEN** configuration is rejected naming the duplicated ID

#### Scenario: A channel ID reused across servers

- **WHEN** one channel ID appears under two different servers
- **THEN** configuration is rejected naming the channel and both servers
- **AND** the system does not start, because that configuration would post one server's messages twice into a single channel and never into the other

#### Scenario: A malformed identifier

- **WHEN** any declared guild or channel identifier is not a 17-20 digit snowflake
- **THEN** configuration is rejected naming that variable and its position in the list

#### Scenario: The API keeps serving when server configuration is invalid

- **WHEN** server configuration is rejected
- **THEN** the HTTP API continues to serve requests
- **AND** the reason is recorded so the status endpoints can report it

### Requirement: Every configured channel is verified to belong to the server it was configured under

The system SHALL verify, once the gateway connection is ready and before the features that depend on those channels run, that each configured channel identifier resolves to a channel in the server it was configured under. A channel that resolves into a different server, or that cannot be resolved at all, SHALL disqualify that server from the features needing it, SHALL be reported, and SHALL NOT be assumed correct on the grounds that the identifier is well-formed. This verification SHALL NOT be performed or replaced by matching a channel's name.

This requirement exists because the configured servers name their channels identically, so a misaligned configuration produces a channel of exactly the expected name in the wrong server and is indistinguishable from a correct one by inspection.

#### Scenario: Channels verified at startup

- **WHEN** the gateway reports ready
- **THEN** each configured server's attendance, daily-update, and reminder channel identifiers are each resolved once
- **AND** each is confirmed to belong to the server it was configured under

#### Scenario: Two servers' channel identifiers are swapped

- **WHEN** one server's configured daily-update channel identifier names a channel in a different configured server, and that server's identifier names a channel in the first
- **THEN** both servers fail verification and are reported with the server each channel actually belongs to
- **AND** the mistake is caught at startup rather than when the channel is next opened, posted to, or read from
- **AND** static validation of the identifiers alone is not relied on to catch it, because the lists are of equal length and every identifier is a distinct well-formed snowflake

#### Scenario: A channel belongs to no configured server

- **WHEN** a configured channel identifier resolves to a channel in a guild that is not configured, or cannot be resolved at all
- **THEN** that server fails verification and is reported with the reason

#### Scenario: A channel identifier is not a text channel

- **WHEN** a configured channel identifier resolves to a channel that is not a text channel
- **THEN** that server fails verification and is reported with the reason

#### Scenario: Verification failure is isolated to its server

- **WHEN** one configured server fails channel verification
- **THEN** the remaining servers are verified and continue to sync, schedule, announce, and appear on the dashboard
- **AND** the failing server is excluded from the features whose channel could not be verified

#### Scenario: Names are never used to verify or to select

- **WHEN** channel verification runs
- **THEN** it compares the resolved channel's server against the configured server
- **AND** it does not compare, match, or fall back to the channel's name, which is mutable and not unique

#### Scenario: Verification is observable

- **WHEN** an administrator reads the Discord status endpoint after a verification failure
- **THEN** the affected server is listed with the channel that failed and the reason

### Requirement: Every server carries a stable identifier and a human label

Each configured server SHALL be identified by its guild ID in all stored data and in all API responses. A human-readable label MAY be supplied by configuration and SHALL be used for display only. The label SHALL NOT be persisted in any table.

#### Scenario: Label supplied

- **WHEN** a label is configured for a server
- **THEN** API responses report that label alongside the guild ID

#### Scenario: No label supplied

- **WHEN** no label is configured for a server
- **THEN** the server's live Discord name is used when available, and its guild ID otherwise

#### Scenario: A label change requires no data change

- **WHEN** a server's configured label is changed and the system restarts
- **THEN** every existing record for that server is unaffected, because records store the guild ID and never the label

### Requirement: A configured server that cannot be reached is reported, not fatal

The system SHALL treat an unreachable configured server as a degraded condition affecting that server alone. It SHALL NOT prevent startup, SHALL NOT stop the other servers from operating, and SHALL be observable through the administrative status endpoints.

#### Scenario: Bot is not a member of a configured server

- **WHEN** the bot is not in one of the configured guilds at connection time
- **THEN** that server is logged as unreachable with the reason
- **AND** the remaining servers sync, schedule, announce, and report normally
- **AND** the status read shows the unreachable server with its reason

#### Scenario: A server becomes reachable later

- **WHEN** the bot is invited to a previously unreachable configured server and the system reconnects
- **THEN** that server participates in every feature without a configuration change

#### Scenario: Every configured server is unreachable

- **WHEN** none of the configured servers can be reached
- **THEN** the HTTP API still serves requests
- **AND** the status read reports every server as unreachable

### Requirement: One bot identity serves every configured server

The system SHALL connect to Discord with a single bot token and a single gateway client covering every configured server. It SHALL NOT open a separate connection per server.

#### Scenario: Single connection covers both servers

- **WHEN** the bot is connected
- **THEN** events from every configured server arrive on the one connection
- **AND** the Discord rate-limit budget is shared across servers rather than divided

#### Scenario: Degraded intent mode applies to every server at once

- **WHEN** login is rejected for disallowed intents and the client is rebuilt without message content
- **THEN** member sync continues for every configured server
- **AND** daily-update ingestion is disabled for every configured server
- **AND** the degraded reason is reported once, as a property of the connection rather than of any one server

### Requirement: Adding a server requires configuration and a restart, not a code change

The system SHALL support adding a further server by declaring it in configuration and restarting. No source change, schema change, or migration SHALL be required.

#### Scenario: A third server is added

- **WHEN** a third guild and its channels are appended to the configuration and the system restarts
- **THEN** the new server is synced, scheduled, announced to, included in broadcasts, and visible on the dashboard
- **AND** no existing server's data or behaviour changes