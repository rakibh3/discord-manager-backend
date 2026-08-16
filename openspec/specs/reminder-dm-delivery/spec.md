# reminder-dm-delivery Specification

## Purpose

Defines what a single reminder DM is, and what happens to the members who cannot receive one. Recipients are addressed by Discord user ID and never by handle: handles are mutable, so a lookup by handle can deliver a private message to whoever now holds the old one. Every targeted member of a broadcast ends with exactly one recorded outcome — delivered, DM-closed, or failed — carrying the time it was sent or the reason it was not.

A closed DM is an outcome, not a failure. The member has chosen not to accept messages from the bot, which no retry can change, so it is recorded once and answered another way: when the broadcast finishes, those members are mentioned in the configured reminder channel, split across as many messages as the length limit requires. That announcement is restricted to resolve only the members it names, so no text it carries can turn a reminder into a ping of the whole server.

Delivery runs inside a queue job, which has no request to fail. The sending code therefore returns a structured outcome rather than raising out of itself, and holds no HTTP status codes and no request-scoped error types. The reminder channel, like every other channel in the system, is resolved from configuration and never selected by name.

## Requirements

### Requirement: A reminder is addressed by Discord user ID

The system SHALL address every reminder DM by the member's Discord user ID and SHALL NOT resolve the recipient by handle. Handles are mutable, so a lookup by handle can deliver a private message to whoever holds the old one.

#### Scenario: Recipient resolved

- **WHEN** a reminder is delivered to a member
- **THEN** the recipient is resolved from the stored Discord user ID

#### Scenario: Member renamed since the last sync

- **WHEN** a targeted member changed their handle after the directory was last synced
- **THEN** the reminder still reaches that member, because the identifier used does not change

#### Scenario: Account no longer exists

- **WHEN** the Discord user ID cannot be resolved because the account was deleted
- **THEN** the recipient is recorded as failed with the reason, and no message is sent to anyone else

### Requirement: The DM carries the administrator's message under a fixed heading

The system SHALL deliver the administrator's message text preceded by a fixed reminder heading, so a recipient can tell at a glance that the message is the daily-update reminder and not an arbitrary bot DM.

#### Scenario: Message delivered

- **WHEN** a DM is delivered
- **THEN** it contains the fixed reminder heading followed by the message stored on the broadcast session

#### Scenario: Message read from the session

- **WHEN** a delivery job runs
- **THEN** the message text comes from the broadcast session record, so the text delivered and the text audited can never differ

### Requirement: Every targeted member ends with exactly one recorded outcome

The system SHALL record, for each targeted member of a broadcast, exactly one terminal outcome: delivered, DM-closed, or failed. A failure SHALL store the error detail, and a delivery SHALL store the time it was sent.

#### Scenario: Successful delivery

- **WHEN** a DM is accepted by Discord
- **THEN** the recipient is recorded as delivered with the time it was sent

#### Scenario: Failure detail retained

- **WHEN** a delivery fails
- **THEN** the recipient's record stores the reason, so the failure can be diagnosed after the run

#### Scenario: No duplicate recipient record

- **WHEN** a delivery job for a member runs more than once within one broadcast
- **THEN** the member still has exactly one recipient record

#### Scenario: Never attempted

- **WHEN** a broadcast ends without a member's delivery having been attempted
- **THEN** that member's record remains in the not-yet-attempted state rather than being recorded as delivered or failed

### Requirement: A closed DM is a recorded outcome, not a delivery failure

When Discord refuses a DM because the member does not accept messages from the bot, the system SHALL record that member as DM-closed, SHALL NOT retry, and SHALL NOT treat the job as failed. The condition cannot change on a retry, and the fallback announcement is the system's response to it.

#### Scenario: Member has DMs disabled

- **WHEN** Discord refuses the DM because the member cannot be messaged
- **THEN** the recipient is recorded as DM-closed
- **AND** no retry is attempted

#### Scenario: DM-closed counted separately from failure

- **WHEN** a broadcast's outcome is reported
- **THEN** DM-closed recipients are distinguishable from recipients that failed for other reasons

#### Scenario: DM-closed recipients are listable

- **WHEN** a broadcast has finished
- **THEN** the members recorded as DM-closed can be listed as a group for the fallback announcement

### Requirement: Members who could not be DMed are reached in the fallback channel

Once a broadcast finishes, the system SHALL post a mention of every DM-closed recipient in the configured reminder channel, split across as many messages as needed to stay within Discord's message length limit.

#### Scenario: Fallback posted

- **WHEN** a broadcast finishes with one or more DM-closed recipients
- **THEN** those members are mentioned in the configured reminder channel

#### Scenario: More recipients than fit in one message

- **WHEN** the DM-closed recipients would exceed Discord's message length limit
- **THEN** the mentions are split across multiple messages, each within the limit

#### Scenario: No closed DMs

- **WHEN** a broadcast finishes with no DM-closed recipients
- **THEN** no fallback message is posted

#### Scenario: Fallback posted once

- **WHEN** a broadcast's final delivery completes and more than one worker observes that the broadcast has drained
- **THEN** the fallback announcement is posted exactly once

#### Scenario: Fallback fails

- **WHEN** the fallback message cannot be posted, for example because the bot lacks permission in that channel
- **THEN** the failure is logged and reported through the reminder status
- **AND** the broadcast's recorded delivery outcomes are unaffected

### Requirement: The fallback announcement cannot become a mass ping

The system SHALL restrict the mentions a fallback message is permitted to resolve to the specific members it names. Everyone-mentions, here-mentions, and role mentions SHALL be structurally impossible from this code path, whatever text surrounds the mentions.

#### Scenario: Only named members are pinged

- **WHEN** a fallback message is posted
- **THEN** only the members named in that message are notified

#### Scenario: Text containing an everyone-mention

- **WHEN** the surrounding text of a fallback message would otherwise resolve an everyone-mention, a here-mention, or a role mention
- **THEN** it does not notify anyone beyond the named members

### Requirement: The fallback channel is identified by configuration

The system SHALL resolve the fallback channel from the configured reminder channel ID and SHALL NOT select a channel by name.

#### Scenario: Channel resolved from configuration

- **WHEN** a fallback announcement is posted
- **THEN** the target channel is the one named by the configured reminder channel ID

#### Scenario: Channel unreachable

- **WHEN** the configured reminder channel cannot be fetched or is not a text channel
- **THEN** the failure is logged identifying the configured channel ID and reported through the reminder status

### Requirement: Sending a DM or a fallback message never throws past its own boundary

Reminder delivery runs in a queue job with no request to fail, so the system SHALL return a structured outcome from every send rather than raising an error out of the sending code, and SHALL keep HTTP status codes and request-scoped error types out of it.

#### Scenario: Discord rejects a send

- **WHEN** Discord rejects a DM or a channel message
- **THEN** the sending code returns a result describing the rejection rather than throwing out of the module

#### Scenario: Unexpected error while sending

- **WHEN** an unanticipated error occurs while sending
- **THEN** it is contained, logged, and expressed as a failed result
