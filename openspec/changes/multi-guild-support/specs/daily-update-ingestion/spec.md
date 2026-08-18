## MODIFIED Requirements

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
