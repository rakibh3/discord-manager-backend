# daily-update-ingestion Specification

## Purpose

Defines how messages posted in the `#daily-update` Discord channel become `daily_updates` rows in real time. This is the second half of what the dashboard and the reminder queue measure: attendance arrives through the web form, the daily update arrives as a Discord message, and a member is only "complete" for a day when both exist.

Three constraints shape the behavior. Ingestion is immediate rather than batched, because a message that is not stored on arrival is a student marked absent. Attribution is by immutable Discord snowflake plus the server the message originated in, so a rename cannot misfile or lose an update and a member who is in two servers has every update credited to the server it was posted in. And duplicate suppression is a database constraint on `discord_message_id`, not a read-then-write check, so a replayed gateway event after a reconnect cannot create a second row.

Ingestion runs inside a gateway listener, which has no HTTP request to fail. Every failure is contained and logged rather than thrown.

## Requirements

### Requirement: Only messages in the configured daily-update channel are ingested

The system SHALL ingest a message only when it was posted in the daily-update channel **of the configured server the message came from**. Channel selection SHALL be by identifier only; the system SHALL NOT key any ingestion logic off a channel's name, and it SHALL NOT accept a daily-update channel identifier belonging to a different configured server.

#### Scenario: Message in a server's daily-update channel

- **WHEN** a non-bot user posts a message in the channel configured as the daily-update channel for the server the message came from
- **THEN** the message is ingested and attributed to that server

#### Scenario: Message in the other server's daily-update channel

- **WHEN** a non-bot user posts in the second configured server's daily-update channel
- **THEN** the message is ingested and attributed to that second server

#### Scenario: Message in any other channel

- **WHEN** a message is posted in a channel that is not the daily-update channel of the server it came from
- **THEN** the message is ignored and no record is written

#### Scenario: Message in an unconfigured guild

- **WHEN** a message arrives from a guild that is not in the configured server list
- **THEN** the message is ignored

#### Scenario: Channel identifier from the wrong server

- **WHEN** a message arrives in a channel whose identifier matches a **different** configured server's daily-update channel than the guild it came from
- **THEN** the message is ignored, because the channel must belong to the server the message originated in

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

The system SHALL resolve a message author to a stored member using the author's Discord user ID **within the server the message was posted in**, never their handle and never across servers. Discord handles are mutable, so a rename between sync and posting would otherwise attribute an update to the wrong row or to none; and the same account may hold a record in more than one server, so the lookup must name the server or it could credit the wrong one.

#### Scenario: Author has a stored member record in that server

- **WHEN** a message arrives from an author whose Discord user ID matches a member record belonging to the server the message came from
- **THEN** the stored update is linked to that member record's `id`

#### Scenario: Author is a member of both servers

- **WHEN** an author who holds a member record in two configured servers posts in one of them
- **THEN** the update is linked to that server's member record only
- **AND** the other server's record is unaffected and the author still shows as missing an update there

#### Scenario: Author renamed since the last sync

- **WHEN** a message arrives from an author whose current handle does not match the handle stored for their Discord user ID
- **THEN** the update is still linked to the correct member record via their Discord user ID and the originating server
- **AND** no second member record is created for the new handle

#### Scenario: Departed members still own their messages

- **WHEN** a message arrives from an author whose record in that server is flagged as departed
- **THEN** the lookup still resolves them, because the question is whose message this is rather than whether they may submit now

### Requirement: An unknown author is added to the directory before ingestion

The system SHALL, when a message author has no member record **in the server the message came from**, fetch that member from **that server** and upsert them into the directory through the same member-upsert path used by member sync, then ingest the message. A gap between a member joining and the directory recording them SHALL NOT cost that student credit for their update.

#### Scenario: Author missing from that server's directory

- **WHEN** a message arrives from an author who has no member record for that server and who is currently a member of it
- **THEN** the member is fetched from that server and written to the directory under that server
- **AND** the message is then ingested and linked to the newly created member record

#### Scenario: Author known in the other server only

- **WHEN** a message arrives from an author who has a member record in a different configured server but none in this one
- **THEN** a new member record is created for this server rather than the existing record of the other server being reused or moved
- **AND** the message is linked to the newly created record

#### Scenario: Author is a departed member with a stored record

- **WHEN** a message arrives from an author whose record in that server is flagged as no longer in the guild
- **THEN** the record is reactivated as part of the upsert
- **AND** the message is ingested

#### Scenario: Author cannot be fetched from Discord

- **WHEN** the member fetch for an unknown author fails or returns no member
- **THEN** the message is not stored
- **AND** a warning is logged naming the author's Discord user ID, the server, and the message ID

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
