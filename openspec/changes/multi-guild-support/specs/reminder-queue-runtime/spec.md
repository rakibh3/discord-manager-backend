## MODIFIED Requirements

### Requirement: A repeated job does not deliver a second DM

Queue delivery is at-least-once, so the system SHALL make a repeated job harmless. A job SHALL be identified by the broadcast and the **Discord account** it contacts — not by the member record — so that enqueuing the same broadcast and account twice cannot create two jobs even when that account is a targeted member of more than one configured server. A job SHALL check the recorded state of every recipient record it would settle before sending, so that a retry after a recorded success does nothing.

#### Scenario: Duplicate enqueue

- **WHEN** the same broadcast and Discord account are enqueued twice
- **THEN** only one job exists for that pair

#### Scenario: One account targeted through two servers

- **WHEN** a broadcast targets one Discord account through member records in two configured servers
- **THEN** exactly one job is created for that account
- **AND** the job carries every member record it is responsible for settling

#### Scenario: Retry after a recorded outcome

- **WHEN** a job runs and every recipient record it is responsible for is already recorded as terminal
- **THEN** no DM is sent and the recorded outcomes are left unchanged

#### Scenario: Partially recorded outcome

- **WHEN** a job runs and some of its recipient records are already terminal while others are not
- **THEN** the delivery proceeds and every one of its records is settled, so no server is left with a permanently pending record

#### Scenario: Job identity contains no reserved separator

- **WHEN** a job identifier is constructed from the broadcast and the Discord account
- **THEN** it contains no character the queue reserves as a key separator, so enqueuing cannot fail after the session and recipient records have been written

#### Scenario: Failure between sending and recording

- **WHEN** a DM is sent but the process stops before the outcomes are recorded
- **THEN** the retry may deliver the DM a second time, and this is preferred over a member being recorded as reminded without having been

## ADDED Requirements

### Requirement: The delivery rate limit stays shared across every server

The system SHALL apply one delivery rate limit to the whole queue, counted in shared storage, regardless of how many configured servers a broadcast covers. Fan-out across servers SHALL NOT multiply the rate at which DMs leave the bot.

#### Scenario: Broadcast covering two servers

- **WHEN** a broadcast covering two configured servers is delivered
- **THEN** DMs leave at the configured per-second rate in total, not per server

#### Scenario: The limit is not divided per server

- **WHEN** the configured rate is read
- **THEN** it is applied as one budget for the bot, because the bot's Discord rate limit is a property of the bot rather than of a server

#### Scenario: Multiple workers

- **WHEN** more than one worker consumes the queue
- **THEN** they still deliver within the single shared budget
