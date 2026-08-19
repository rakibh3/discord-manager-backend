# channel-schedule-automation Specification

## Purpose

Defines the timed behavior that gives `#daily-update` a submission window: opening the channel to `@everyone` at the configured time, locking it at the configured close time, and announcing each transition. The window is enforced by the channel's own permissions and nowhere else — daily-update ingestion deliberately stores whatever arrives whenever it arrives, so a second time check there could only disagree with this one.

The schedule is shared across every configured server; the actions that follow the schedule — open, lock, reconcile, manual override — fan out to each server's own channel in turn. A failure in one server's channel operation never prevents another server from being acted on, and per-server state is reported individually rather than collapsed.

Three properties matter beyond the two timers. The channel's real state is read from Discord rather than cached, because an administrator can change the overwrite by hand at any moment. The state is reconciled at startup, because a process that restarts at 8:00 PM would otherwise leave the channel locked for the rest of the evening with no error raised anywhere — and that reconciliation is silent, since a restart loop must never post its announcements into a channel thousands of students read. And an administrator can always force the channel open or locked immediately, independently of the schedule.

Like the gateway handlers, this runs outside any HTTP request: every failure is contained, logged, and recorded as the last run's outcome, which is reported to administrators because a scheduler that cannot edit the overwrite has no other visible symptom.

## Requirements

### Requirement: The daily-update channel opens on the configured schedule

The system SHALL, at the configured open time on each active weekday, grant `SendMessages` to the `@everyone` role on the daily-update channel of **every configured server**, and post an opening announcement in each of those channels. One shared schedule SHALL drive every server. Each server's channel SHALL be identified by that server's configured daily-update channel identifier; no scheduling logic SHALL key off a channel's name.

#### Scenario: Open time reached on an active day

- **WHEN** the Dhaka wall clock reaches the configured open time on a weekday included in the schedule
- **THEN** the `@everyone` permission overwrite on each configured server's daily-update channel is updated to allow `SendMessages`
- **AND** an opening announcement embed is posted in each of those channels

#### Scenario: One server fails to open

- **WHEN** the open job runs and one server's permission edit is rejected by Discord
- **THEN** the other servers' channels are still opened and announced
- **AND** the failing server's error is recorded against that server for the status read

#### Scenario: Open time reached on an excluded day

- **WHEN** the configured open time is reached on a weekday not included in the schedule
- **THEN** no permission change is made and no announcement is posted in any server

#### Scenario: Schedule is disabled

- **WHEN** the schedule's enabled flag is false
- **THEN** neither the open nor the lock job runs at any time, in any server

#### Scenario: Channel already open

- **WHEN** the open job runs while `SendMessages` is already allowed in a server
- **THEN** the permission edit is applied without error and the announcement is still posted in that server

### Requirement: The daily-update channel locks on the configured schedule

The system SHALL, at the configured close time on each active weekday, deny `SendMessages` for the `@everyone` role on the daily-update channel of **every configured server**, and post a closing announcement in each. The lock SHALL NOT remove the ability to view the channel, so the announcement and the day's messages remain readable.

#### Scenario: Close time reached on an active day

- **WHEN** the Dhaka wall clock reaches the configured close time on a weekday included in the schedule
- **THEN** the `@everyone` permission overwrite is updated to deny `SendMessages` in every configured server
- **AND** a closing announcement embed is posted in each of those channels

#### Scenario: One server fails to lock

- **WHEN** one server's lock is rejected by Discord
- **THEN** the remaining servers are still locked
- **AND** the failing server's error is recorded against that server, because a channel left open past its close time accepts submissions that the day's reports will not expect

#### Scenario: Viewing survives the lock

- **WHEN** the channel has been locked
- **THEN** members can still read the channel and its history

#### Scenario: A message sent before the lock is still ingested

- **WHEN** a message is sent moments before the close time and reaches the ingestion path after it
- **THEN** the message is stored and attributed to the Dhaka date it was sent on and to the server it was posted in

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

The system SHALL, when the scheduler starts, determine whether the current Dhaka time falls inside the configured window for the current weekday and correct the permission overwrite of **every configured server's** daily-update channel that disagrees. Each server SHALL be reconciled independently. A reconciliation SHALL NOT post an announcement in any server.

#### Scenario: Process starts inside the window with the channel locked

- **WHEN** the scheduler starts at 20:00 Dhaka time with a window of 18:00–23:59 and `SendMessages` currently denied in a server
- **THEN** `SendMessages` is granted in that server
- **AND** no announcement is posted
- **AND** the correction is logged naming the server

#### Scenario: Servers in different states

- **WHEN** the scheduler starts inside the window with one server's channel open and the other's locked
- **THEN** only the locked server is corrected
- **AND** no announcement is posted in either

#### Scenario: One server unreachable during reconcile

- **WHEN** one server's channel cannot be read or edited at startup
- **THEN** the failure is logged against that server and the remaining servers are still reconciled

#### Scenario: Process starts outside the window with the channel open

- **WHEN** the scheduler starts at 09:00 Dhaka time with a window of 18:00–23:59 and `SendMessages` currently allowed
- **THEN** `SendMessages` is denied
- **AND** no announcement is posted

#### Scenario: Channel already in the expected state

- **WHEN** the scheduler starts and a server's live permission already matches what the schedule implies
- **THEN** no permission edit is issued for that server

#### Scenario: Restart loop

- **WHEN** the process restarts several times in succession
- **THEN** no announcement is posted by any of the reconciliations, in any server

#### Scenario: Schedule disabled at startup

- **WHEN** the scheduler starts while the schedule's enabled flag is false
- **THEN** no reconciliation is performed and every channel is left in whatever state it is in

### Requirement: The current channel state is read from Discord

The system SHALL determine whether a server's channel is currently open by reading that channel's live `@everyone` permission overwrite, never from a stored flag or cached value. State SHALL be reported per configured server.

#### Scenario: Permission changed manually in Discord

- **WHEN** an administrator changes one server's channel `SendMessages` overwrite directly in the Discord client
- **THEN** the state subsequently reported for that server reflects that change
- **AND** the other server's reported state is unaffected

#### Scenario: One channel unreachable

- **WHEN** one server's channel cannot be fetched
- **THEN** that server's state is reported as unknown rather than assumed
- **AND** the other servers' states are still reported

### Requirement: An admin can force the channel open or locked immediately

The system SHALL expose administrator-only actions that open or lock the daily-update channel at once, independently of the schedule and without modifying it. Such an action SHALL apply to every configured server by default, and MAY be restricted to named servers. The response SHALL report the outcome per server.

#### Scenario: Manual open

- **WHEN** an authenticated administrator invokes the manual open action
- **THEN** `SendMessages` is granted and the opening announcement is posted in every configured server, and the stored schedule is unchanged
- **AND** the response reports the outcome for each server

#### Scenario: Manual lock

- **WHEN** an authenticated administrator invokes the manual lock action
- **THEN** `SendMessages` is denied and the closing announcement is posted in every configured server, and the stored schedule is unchanged

#### Scenario: Manual action targeting one server

- **WHEN** an authenticated administrator invokes a manual action naming a single configured server
- **THEN** only that server's channel is changed
- **AND** naming a server that is not configured is refused

#### Scenario: Manual action partially fails

- **WHEN** a manual action succeeds in one server and fails in another
- **THEN** the request succeeds and names the failed server with its error, rather than reporting that nothing happened

#### Scenario: Manual action while the schedule is disabled

- **WHEN** the schedule is disabled and an administrator invokes a manual action
- **THEN** the action is performed, because it does not depend on the scheduler running

#### Scenario: Unauthenticated caller

- **WHEN** a request without a valid administrator token invokes a manual action
- **THEN** it is rejected and no permission change is made in any server

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

The system SHALL report, to administrators, whether the scheduler is running, the next scheduled open and lock times, and — **for each configured server** — that server's live channel state and the outcome of the most recent run against it including any error.

#### Scenario: Healthy scheduler

- **WHEN** an administrator requests the scheduler's status
- **THEN** the response reports it as running, with the next open and lock times as instants
- **AND** it lists every configured server with its live channel state

#### Scenario: Last run failed in one server

- **WHEN** the most recent open or lock attempt failed in one server and succeeded in another
- **THEN** the response reports the action and time, the failing server with its error message, and the succeeding server without one

#### Scenario: Scheduler disabled for this process

- **WHEN** the process is configured not to run scheduled jobs
- **THEN** the response reports the scheduler as not running in this process, and reports no next run times
- **AND** the per-server live channel states are still reported

### Requirement: One shared schedule produces one timed firing that fans out

The system SHALL register the timed open and lock jobs once from the single stored schedule, and each firing SHALL fan out across the configured servers. It SHALL NOT register a separate timed job per server.

#### Scenario: One firing covers every server

- **WHEN** the open time is reached
- **THEN** exactly one open job runs and acts on every configured server in turn

#### Scenario: Schedule reload

- **WHEN** the stored schedule is changed and the jobs are re-registered
- **THEN** the previous jobs are destroyed rather than merely stopped, so no job can later fire on a schedule no stored row describes

#### Scenario: Servers are acted on sequentially

- **WHEN** a firing fans out
- **THEN** the servers' Discord calls are issued one after another rather than concurrently
