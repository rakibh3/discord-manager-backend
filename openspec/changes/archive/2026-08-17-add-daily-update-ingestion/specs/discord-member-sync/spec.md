## MODIFIED Requirements

### Requirement: Member directory stays current through gateway events

The system SHALL listen for member lifecycle events so the directory reflects the guild between full syncs. The directory SHALL additionally be repaired on demand from any gateway event that identifies a guild member, including a message posted in the daily-update channel, so that a member who is not yet recorded is added rather than causing the event to be dropped.

#### Scenario: Member joins

- **WHEN** a non-bot user joins the guild
- **THEN** their member record is created or reactivated immediately

#### Scenario: Member leaves

- **WHEN** a user leaves or is removed from the guild
- **THEN** their record is marked as no longer in the guild

#### Scenario: Username changes

- **WHEN** a tracked user changes their account username
- **THEN** the stored normalized username is updated to the new value

#### Scenario: Display name or avatar changes

- **WHEN** a tracked member changes their server nickname or avatar
- **THEN** the stored display name and avatar URL are updated
- **AND** the normalized username is left unchanged

#### Scenario: Event for an unknown member

- **WHEN** an update event arrives for a user who has no stored record
- **THEN** a record is created from the event payload rather than the event being dropped

#### Scenario: Message received from an unrecorded member

- **WHEN** a message arrives in the daily-update channel from a non-bot author who has no stored member record
- **THEN** the member is fetched and written to the directory through the same upsert path as member sync
- **AND** the resulting record is indistinguishable from one written by a member event or a full sync

#### Scenario: Directory repair reuses the shared upsert path

- **WHEN** any caller outside `src/lib/discord/` needs to record a member seen at runtime
- **THEN** it uses the shared member upsert rather than writing `discord_members` directly, so username-collision handling and reactivation behave identically
