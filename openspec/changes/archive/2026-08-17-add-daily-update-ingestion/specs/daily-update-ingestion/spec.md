## ADDED Requirements

### Requirement: Only messages in the configured daily-update channel are ingested

The system SHALL ingest a message only when it was posted in the channel identified by `DAILY_UPDATE_CHANNEL_ID`, in the configured guild. Channel selection SHALL be by identifier only; the system SHALL NOT key any ingestion logic off a channel's name.

#### Scenario: Message in the daily-update channel

- **WHEN** a non-bot user posts a message in the channel whose ID equals `DAILY_UPDATE_CHANNEL_ID`
- **THEN** the message is ingested

#### Scenario: Message in any other channel

- **WHEN** a message is posted in any channel whose ID differs from `DAILY_UPDATE_CHANNEL_ID`
- **THEN** the message is ignored and no record is written

#### Scenario: Message in another guild

- **WHEN** a message arrives from a guild other than the configured `DISCORD_GUILD_ID`
- **THEN** the message is ignored

#### Scenario: Direct message to the bot

- **WHEN** a message arrives that has no guild (a DM to the bot)
- **THEN** the message is ignored

### Requirement: Bot and system messages are excluded

The system SHALL ignore messages authored by bots (including its own) and Discord system messages, so that channel-open and channel-close announcements are never recorded as student updates.

#### Scenario: Message from a bot

- **WHEN** a message in the daily-update channel is authored by a user flagged as a bot
- **THEN** the message is ignored

#### Scenario: The bot's own channel announcement

- **WHEN** the bot posts its own "channel is open" or "channel is closed" embed in the daily-update channel
- **THEN** that message is ignored and produces no `daily_updates` row

#### Scenario: Discord system message

- **WHEN** a message is a Discord system message such as a pin notification or a join announcement
- **THEN** the message is ignored

### Requirement: The message author is resolved by Discord snowflake

The system SHALL resolve a message author to a stored member using the author's Discord user ID, never their handle. Discord handles are mutable, so a rename between sync and posting would otherwise attribute an update to the wrong row or to none.

#### Scenario: Author has a stored member record

- **WHEN** a message arrives from an author whose Discord user ID matches a `discord_members` row
- **THEN** the stored update is linked to that member's `id`

#### Scenario: Author renamed since the last sync

- **WHEN** a message arrives from an author whose current handle does not match the handle stored for their Discord user ID
- **THEN** the update is still linked to the correct member via their Discord user ID
- **AND** no second member record is created for the new handle

### Requirement: An unknown author is added to the directory before ingestion

The system SHALL, when a message author has no `discord_members` row, fetch that member from Discord and upsert them into the directory through the same member-upsert path used by member sync, then ingest the message. A gap between a member joining and the directory recording them SHALL NOT cost that student credit for their update.

#### Scenario: Author missing from the directory

- **WHEN** a message arrives from an author who has no stored member record and who is currently a guild member
- **THEN** the member is fetched from Discord and written to the directory
- **AND** the message is then ingested and linked to the newly created member record

#### Scenario: Author is a departed member with a stored record

- **WHEN** a message arrives from an author whose stored record is flagged as no longer in the guild
- **THEN** the record is reactivated as part of the upsert
- **AND** the message is ingested

#### Scenario: Author cannot be fetched from Discord

- **WHEN** the member fetch for an unknown author fails or returns no member
- **THEN** the message is not stored
- **AND** a warning is logged naming the author's Discord user ID and the message ID

### Requirement: The message date is derived from when the message was sent

The system SHALL derive `message_date` by applying the shared Dhaka civil-date helper to the message's own creation timestamp, and SHALL store that timestamp as `message_created_at`. The date SHALL NOT be derived from the time of processing.

#### Scenario: Message sent just before midnight

- **WHEN** a message is sent at 23:58 Asia/Dhaka and is persisted at 00:01 the following day
- **THEN** `message_date` is the calendar date on which the message was sent
- **AND** `message_created_at` is the instant the message was sent

#### Scenario: Server running in a non-Dhaka timezone

- **WHEN** the process runs with a `TZ` other than `Asia/Dhaka`
- **THEN** the derived `message_date` is identical to what it would be under `TZ=Asia/Dhaka`

### Requirement: Ingestion happens immediately and is idempotent

The system SHALL write each message to `daily_updates` as it arrives, never batching for later processing. Duplicate suppression SHALL rely on the unique constraint on `discord_message_id` rather than a read-then-write existence check.

#### Scenario: First delivery of a message

- **WHEN** a qualifying message is received for the first time
- **THEN** one `daily_updates` row is created with the message content, its channel ID, its Discord message ID, and its derived date

#### Scenario: Gateway event replayed after a reconnect

- **WHEN** the same Discord message ID is delivered a second time
- **THEN** no second row is created
- **AND** the handler resolves to the existing row and reports it as not newly created

#### Scenario: Multiple messages from one member in a day

- **WHEN** the same member posts several messages on the same Dhaka date
- **THEN** each message is stored as its own row

### Requirement: Successful first ingestion is acknowledged with a reaction

The system SHALL add a ✅ reaction to a message once it has been stored for the first time, giving the student visible confirmation. A message resolved as an already-stored duplicate SHALL NOT be re-acknowledged.

#### Scenario: Message stored for the first time

- **WHEN** a message is newly written to `daily_updates`
- **THEN** the bot reacts to that message with ✅

#### Scenario: Duplicate delivery

- **WHEN** a message is resolved to an existing stored row
- **THEN** no reaction is added

#### Scenario: Reaction fails

- **WHEN** adding the reaction fails because the bot lacks the Add Reactions permission or the message was deleted
- **THEN** the failure is logged
- **AND** the stored record is kept, because the record is the source of truth and the reaction is only an acknowledgement

### Requirement: Ingestion failures never crash the process

The system SHALL contain every error raised while handling a message event, so that neither the Discord gateway connection nor the HTTP API is affected.

#### Scenario: Database unavailable during ingestion

- **WHEN** the write to `daily_updates` fails because the database is unreachable
- **THEN** the error is logged with the message ID and author ID
- **AND** the process stays alive and continues handling subsequent events

#### Scenario: Unexpected error in the handler

- **WHEN** any unexpected error is raised while processing a message event
- **THEN** it is caught and logged rather than surfacing as an unhandled rejection

### Requirement: Message content is stored as sent

The system SHALL store the message's raw text content. A message carrying only attachments or embeds SHALL still be recorded, so that a student who submits their update as an image is not counted as missing.

#### Scenario: Text message

- **WHEN** a message with text content is ingested
- **THEN** the stored `message` field contains that text unmodified

#### Scenario: Attachment-only message

- **WHEN** a message has empty text content but carries at least one attachment or embed
- **THEN** the message is still ingested and acknowledged

#### Scenario: Message with no content at all

- **WHEN** a message has empty text content and no attachments or embeds
- **THEN** the message is ignored and no row is written

### Requirement: Edits and deletions do not alter stored updates

The system SHALL treat a stored update as the message as originally sent. Later edits or deletions of the Discord message SHALL NOT modify or remove the stored row.

#### Scenario: Message edited after ingestion

- **WHEN** a student edits their message after it has been ingested
- **THEN** the stored content remains the text as originally sent

#### Scenario: Message deleted after ingestion

- **WHEN** a message is deleted from the channel after ingestion
- **THEN** the stored row remains and the member's status for that day is unchanged
