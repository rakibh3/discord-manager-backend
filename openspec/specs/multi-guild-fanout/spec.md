# multi-guild-fanout Specification

## Purpose

Defines how an administrative action against a shared setting is applied to every configured server. The fan-out runs sequentially rather than concurrently, isolates per-server failures, and reports a per-server outcome so partial success is visible rather than lost. Shared settings are stored once and cannot drift between servers; only the history of what happened is recorded per server.

## Requirements

### Requirement: One administrative action applies to every configured server

An action an administrator takes against a shared setting — opening or locking the daily-update channel, posting the announcement, starting a reminder broadcast, running a member sync — SHALL be applied to every configured server. The administrator SHALL NOT have to repeat the action per server, and the API SHALL NOT require a server to be named for the action to be complete.

#### Scenario: Unlocking reaches every server

- **WHEN** an administrator opens the daily-update channel
- **THEN** the channel is opened in every configured server

#### Scenario: Locking reaches every server

- **WHEN** an administrator locks the daily-update channel
- **THEN** the channel is locked in every configured server

#### Scenario: Announcing reaches every server

- **WHEN** the announcement is posted, whether on schedule or manually
- **THEN** it is posted to the attendance channel of every configured server

#### Scenario: A single server can still be targeted deliberately

- **WHEN** an administrator names one or more servers on an action that supports it
- **THEN** only the named servers are acted on
- **AND** naming a server that is not configured is refused rather than silently ignored

### Requirement: A failure in one server never prevents another server from being acted on

Each server's portion of a fanned-out action SHALL be executed in isolation. A failure — a missing permission, an unreachable channel, a Discord API error — SHALL be caught, recorded against that server, and SHALL NOT stop the remaining servers from being processed.

#### Scenario: One server lacks the required permission

- **WHEN** the bot lacks Manage Roles on one server's daily-update channel and the channel is opened
- **THEN** the other server's channel is opened successfully
- **AND** the failing server is reported with its Discord error

#### Scenario: One server is unreachable

- **WHEN** one configured server cannot be reached during a fanned-out action
- **THEN** the remaining servers complete their part of the action
- **AND** the unreachable server is reported as failed with the reason

#### Scenario: Failure order does not matter

- **WHEN** the first server processed fails
- **THEN** every subsequent server is still processed

### Requirement: A fanned-out action reports a per-server outcome

Every fanned-out action SHALL return one result entry per server it attempted, each naming the server, whether it succeeded, and — on failure — the reason. It SHALL also return a summary of how many servers were attempted, succeeded, and failed. A caller SHALL NOT have to infer per-server state from an aggregate.

#### Scenario: Every server succeeded

- **WHEN** an action succeeds in all servers
- **THEN** the response lists each server as succeeded
- **AND** the summary reports zero failures

#### Scenario: Some servers succeeded

- **WHEN** an action succeeds in one server and fails in another
- **THEN** the response reports success for the first and the failure reason for the second
- **AND** the summary reports the counts of each

#### Scenario: The failure reason is specific

- **WHEN** a server fails because of a missing Discord permission
- **THEN** its result entry carries the underlying error rather than a generic message

### Requirement: Partial success is reported as success with failures named

An action that succeeded in at least one server SHALL be reported to the caller as a successful request carrying per-server failures, not as a request-level error. Only an action that failed in every server SHALL be reported as an error.

#### Scenario: One of two servers failed

- **WHEN** the channel opens in one server and fails in the other
- **THEN** the request succeeds
- **AND** the response names the failed server, because reporting a request-level failure would wrongly imply that nothing happened

#### Scenario: Every server failed

- **WHEN** the action fails in every configured server
- **THEN** the request is reported as an error naming every server's reason

#### Scenario: No servers are configured for the action

- **WHEN** a fanned-out action is invoked with no reachable configured server
- **THEN** the request is reported as an error stating that no server could be acted on

### Requirement: Servers are processed one at a time

A fanned-out action SHALL process servers sequentially rather than concurrently, so that fan-out multiplies neither the instantaneous Discord API burst nor the shared rate-limit pressure that member sync, ingestion, and reminder delivery depend on.

#### Scenario: Two servers acted on in one request

- **WHEN** an action fans out to two servers
- **THEN** the second server's Discord calls are issued after the first server's have completed

#### Scenario: A slow server does not drop another

- **WHEN** one server's Discord call is slow
- **THEN** the remaining servers are still processed after it, rather than being abandoned

### Requirement: A shared setting is stored once and cannot drift between servers

Configuration that is shared across servers — the channel open and close schedule, the announcement template, its schedule, and its mention allowlist — SHALL be stored in exactly one record. Per-server records SHALL be limited to the history of what happened in each server.

#### Scenario: One schedule drives every server

- **WHEN** an administrator changes the daily-update open time
- **THEN** every configured server's channel opens at the new time
- **AND** no per-server copy of the time exists that could disagree

#### Scenario: One announcement body reaches every server

- **WHEN** an administrator edits the announcement body
- **THEN** every server receives the edited message on the next post

#### Scenario: Outcomes are recorded per server

- **WHEN** a fanned-out action completes
- **THEN** the record of what happened is stored per server, so one server's failure neither hides nor blocks the other's success

### Requirement: Fan-out never causes an action to happen twice in one server

Applying an action to several servers SHALL NOT weaken any existing once-only guarantee within a server. Each server's once-only claim SHALL be independent of every other server's.

#### Scenario: A duplicate-suppressing claim is per server

- **WHEN** a once-per-day action has already been recorded for one server and is invoked again the same day
- **THEN** that server is skipped as already done
- **AND** the other server is still acted on if it has not been

#### Scenario: A failed server does not consume another server's opportunity

- **WHEN** a once-per-day action fails in one server and succeeds in another
- **THEN** the failed server may be retried
- **AND** the succeeded server remains claimed and is not posted to twice

#### Scenario: Concurrent fan-outs do not double-apply

- **WHEN** a scheduled fan-out and a manual fan-out run at the same moment
- **THEN** each server is acted on at most once, enforced per server rather than by timing