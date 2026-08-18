## MODIFIED Requirements

### Requirement: Every targeted member ends with exactly one recorded outcome

The system SHALL record, for each targeted member record of a broadcast, exactly one terminal outcome: delivered, DM-closed, or failed. A failure SHALL store the error detail, and a delivery SHALL store the time it was sent. When one Discord account holds targeted member records in more than one configured server, the single delivery attempt for that account SHALL settle **every** one of those records with the same outcome.

#### Scenario: Successful delivery

- **WHEN** a DM is accepted by Discord
- **THEN** the recipient record is recorded as delivered with the time it was sent

#### Scenario: One account with records in two servers

- **WHEN** a DM is delivered to an account that holds targeted recipient records in two configured servers
- **THEN** both records are recorded as delivered with the same send time
- **AND** each server's audit shows that member as reminded

#### Scenario: Failure detail retained

- **WHEN** a delivery fails
- **THEN** every recipient record for that account stores the reason, so the failure can be diagnosed after the run

#### Scenario: No duplicate recipient record

- **WHEN** a delivery job for an account runs more than once within one broadcast
- **THEN** each of that account's member records still has exactly one recipient record

#### Scenario: Never attempted

- **WHEN** a broadcast ends without an account's delivery having been attempted
- **THEN** every one of its recipient records remains in the not-yet-attempted state rather than being recorded as delivered or failed

### Requirement: Members who could not be DMed are reached in the fallback channel

Once a broadcast finishes, the system SHALL post a mention of every DM-closed recipient in the reminder channel **of the server that recipient's member record belongs to**, split across as many messages as needed to stay within Discord's message length limit. A member SHALL only ever be mentioned in a server they are a member of.

#### Scenario: Fallback posted per server

- **WHEN** a broadcast finishes with DM-closed recipients in two configured servers
- **THEN** each server's reminder channel carries a message mentioning only that server's DM-closed recipients

#### Scenario: An account closed to DMs in both servers

- **WHEN** an account that is a member of two configured servers is recorded DM-closed
- **THEN** it is mentioned once in each of those servers' reminder channels
- **AND** it is not mentioned in a server it does not belong to

#### Scenario: Only one server has closed DMs

- **WHEN** a broadcast finishes with DM-closed recipients in one configured server only
- **THEN** only that server's reminder channel receives a fallback message

#### Scenario: More recipients than fit in one message

- **WHEN** a server's DM-closed recipients would exceed Discord's message length limit
- **THEN** that server's mentions are split across multiple messages, each within the limit

#### Scenario: No closed DMs

- **WHEN** a broadcast finishes with no DM-closed recipients
- **THEN** no fallback message is posted in any server

#### Scenario: Fallback posted once

- **WHEN** a broadcast's final delivery completes and more than one worker observes that the broadcast has drained
- **THEN** the fallback announcement is posted exactly once per server

#### Scenario: Fallback fails in one server

- **WHEN** the fallback message cannot be posted in one server, for example because the bot lacks permission in that channel
- **THEN** the failure is logged and reported through the reminder status naming that server
- **AND** the other servers' fallback messages are still posted
- **AND** the broadcast's recorded delivery outcomes are unaffected

### Requirement: The fallback channel is identified by configuration

The system SHALL resolve each server's fallback channel from that server's configured reminder channel ID and SHALL NOT select a channel by name or use one server's channel for another server's members.

#### Scenario: Channel resolved from configuration

- **WHEN** a fallback announcement is posted for a server
- **THEN** the target channel is the one named by that server's configured reminder channel ID

#### Scenario: Channel unreachable

- **WHEN** a server's configured reminder channel cannot be fetched or is not a text channel
- **THEN** the failure is logged identifying that server and channel ID and reported through the reminder status
- **AND** the other servers' fallback announcements still post

#### Scenario: A member is never announced in the wrong server

- **WHEN** fallback messages are composed
- **THEN** each message names only members whose records belong to the server whose channel it is posted in

## ADDED Requirements

### Requirement: One Discord account receives at most one reminder DM per broadcast

The system SHALL send at most one reminder DM per Discord account per broadcast, regardless of how many configured servers that account is a targeted member of. Delivery SHALL be grouped by Discord account before any DM is sent.

#### Scenario: Account targeted in two servers

- **WHEN** a broadcast targets the same Discord account through member records in two configured servers
- **THEN** exactly one DM is sent to that account

#### Scenario: Grouping happens before enqueuing

- **WHEN** a broadcast's deliveries are prepared
- **THEN** the targets are grouped by Discord account first, so the queue never holds two deliveries for one account within one broadcast

#### Scenario: Rate budget counts accounts, not records

- **WHEN** the delivery rate limit is applied
- **THEN** one account contacted on behalf of two servers consumes one unit of the budget, not two

#### Scenario: The message is the same in every server

- **WHEN** an account is targeted through more than one server
- **THEN** the single DM carries the broadcast's one stored message, because the message is a property of the broadcast rather than of a server
