## ADDED Requirements

### Requirement: The daily-update channel opens on the configured schedule

The system SHALL, at the configured open time on each active weekday, grant `SendMessages` on the daily-update channel to the guild's `@everyone` role and post an opening announcement in that channel. The channel SHALL be identified by `DAILY_UPDATE_CHANNEL_ID`; no scheduling logic SHALL key off a channel's name.

#### Scenario: Open time reached on an active day

- **WHEN** the Dhaka wall clock reaches the configured open time on a weekday included in the schedule
- **THEN** the `@everyone` permission overwrite on the daily-update channel is updated to allow `SendMessages`
- **AND** an opening announcement embed is posted in that channel

#### Scenario: Open time reached on an excluded day

- **WHEN** the configured open time is reached on a weekday not included in the schedule
- **THEN** no permission change is made and no announcement is posted

#### Scenario: Schedule is disabled

- **WHEN** the schedule's enabled flag is false
- **THEN** neither the open nor the lock job runs at any time

#### Scenario: Channel already open

- **WHEN** the open job runs while `SendMessages` is already allowed
- **THEN** the permission edit is applied without error and the announcement is still posted

### Requirement: The daily-update channel locks on the configured schedule

The system SHALL, at the configured close time on each active weekday, deny `SendMessages` on the daily-update channel for the `@everyone` role and post a closing announcement. The lock SHALL NOT remove the ability to view the channel, so the announcement and the day's messages remain readable.

#### Scenario: Close time reached on an active day

- **WHEN** the Dhaka wall clock reaches the configured close time on a weekday included in the schedule
- **THEN** the `@everyone` permission overwrite is updated to deny `SendMessages`
- **AND** a closing announcement embed is posted in that channel

#### Scenario: Viewing survives the lock

- **WHEN** the channel has been locked
- **THEN** members can still read the channel and its history

#### Scenario: A message sent before the lock is still ingested

- **WHEN** a message is sent moments before the close time and reaches the ingestion path after it
- **THEN** the message is stored and attributed to the Dhaka date it was sent on

### Requirement: Announcements are distinguishable and never counted as updates

The system SHALL post the opening and closing announcements as embeds that are visually distinct from one another, authored by the bot. Those announcements SHALL NOT be recorded as daily updates.

#### Scenario: Opening announcement

- **WHEN** the channel is opened on schedule
- **THEN** the announcement states that the channel is open and by when updates must be submitted

#### Scenario: Closing announcement

- **WHEN** the channel is locked on schedule
- **THEN** the announcement states that submission is closed for the day and when the channel reopens

#### Scenario: Announcement reaches the ingestion path

- **WHEN** the bot posts either announcement in the daily-update channel
- **THEN** no `daily_updates` row is created for it, because its author is a bot

### Requirement: Channel state is reconciled at startup

The system SHALL, when the scheduler starts, determine whether the current Dhaka time falls inside the configured window for the current weekday and correct the channel's permission overwrite when it disagrees. A reconciliation SHALL NOT post an announcement.

#### Scenario: Process starts inside the window with the channel locked

- **WHEN** the scheduler starts at 20:00 Dhaka time with a window of 18:00–23:59 and `SendMessages` currently denied
- **THEN** `SendMessages` is granted
- **AND** no announcement is posted
- **AND** the correction is logged

#### Scenario: Process starts outside the window with the channel open

- **WHEN** the scheduler starts at 09:00 Dhaka time with a window of 18:00–23:59 and `SendMessages` currently allowed
- **THEN** `SendMessages` is denied
- **AND** no announcement is posted

#### Scenario: Channel already in the expected state

- **WHEN** the scheduler starts and the live permission already matches what the schedule implies
- **THEN** no permission edit is issued

#### Scenario: Restart loop

- **WHEN** the process restarts several times in succession
- **THEN** no announcement is posted by any of the reconciliations

#### Scenario: Schedule disabled at startup

- **WHEN** the scheduler starts while the schedule's enabled flag is false
- **THEN** no reconciliation is performed and the channel is left in whatever state it is in

### Requirement: The current channel state is read from Discord

The system SHALL determine whether the channel is currently open by reading the live `@everyone` permission overwrite, never from a stored flag or cached value.

#### Scenario: Permission changed manually in Discord

- **WHEN** an administrator changes the channel's `SendMessages` overwrite directly in the Discord client
- **THEN** the state subsequently reported by the system reflects that change

#### Scenario: Channel unreachable

- **WHEN** the channel cannot be fetched
- **THEN** the state is reported as unknown rather than assumed

### Requirement: An admin can force the channel open or locked immediately

The system SHALL expose administrator-only actions that open or lock the daily-update channel at once, independently of the schedule and without modifying it.

#### Scenario: Manual open

- **WHEN** an authenticated administrator invokes the manual open action
- **THEN** `SendMessages` is granted, the opening announcement is posted, and the stored schedule is unchanged

#### Scenario: Manual lock

- **WHEN** an authenticated administrator invokes the manual lock action
- **THEN** `SendMessages` is denied, the closing announcement is posted, and the stored schedule is unchanged

#### Scenario: Manual action while the schedule is disabled

- **WHEN** the schedule is disabled and an administrator invokes a manual action
- **THEN** the action is performed, because it does not depend on the scheduler running

#### Scenario: Unauthenticated caller

- **WHEN** a request without a valid administrator token invokes a manual action
- **THEN** it is rejected and no permission change is made

### Requirement: Scheduler failures never affect the API or the gateway

The system SHALL contain every error raised by a scheduled job, by the boot reconciliation, and by a manual action's Discord call, so that neither the HTTP API nor the Discord gateway connection is disturbed. A failed run SHALL NOT prevent subsequent runs.

#### Scenario: Discord unreachable at the open time

- **WHEN** the open job runs and the Discord API call fails
- **THEN** the error is logged with its cause
- **AND** the process stays alive and the next scheduled run remains registered

#### Scenario: Bot lacks permission to edit the overwrite

- **WHEN** a permission edit is rejected because the bot lacks Manage Roles on the channel
- **THEN** the error is logged naming the missing permission
- **AND** the failure is recorded as the last run's outcome rather than being silently discarded

#### Scenario: Announcement fails after a successful permission change

- **WHEN** the permission edit succeeds but sending the announcement fails
- **THEN** the permission change is kept and the announcement failure is logged, because the window is what matters and the embed is only a notice

#### Scenario: Database unavailable when the job reads its configuration

- **WHEN** the schedule cannot be read from the database
- **THEN** the error is logged and no permission change is made rather than falling back to a guessed schedule

### Requirement: The scheduler's health is observable

The system SHALL report, to administrators, whether the scheduler is running, the next scheduled open and lock times, the channel's live state, and the outcome of the most recent run including any error.

#### Scenario: Healthy scheduler

- **WHEN** an administrator requests the scheduler's status
- **THEN** the response reports it as running, with the next open and lock times as instants

#### Scenario: Last run failed

- **WHEN** the most recent open or lock attempt failed
- **THEN** the response reports that run's action, time, and error message

#### Scenario: Scheduler disabled for this process

- **WHEN** the process is configured not to run scheduled jobs
- **THEN** the response reports the scheduler as not running in this process, and reports no next run times

### Requirement: Only one process runs the scheduled jobs

The system SHALL allow the timed jobs to be switched off per process, so that a horizontally scaled deployment does not open the channel and announce it once per replica. Administrator actions and status reads SHALL remain available on every process.

#### Scenario: Scheduling disabled on a replica

- **WHEN** a process starts with scheduled jobs disabled
- **THEN** no cron jobs are registered and no boot reconciliation is performed by that process

#### Scenario: Manual action on a replica with scheduling disabled

- **WHEN** an administrator invokes a manual open or lock against a process that does not run scheduled jobs
- **THEN** the action is performed normally

#### Scenario: Setting absent

- **WHEN** the setting is not provided
- **THEN** the process runs the scheduled jobs, which is correct for a single-instance deployment
