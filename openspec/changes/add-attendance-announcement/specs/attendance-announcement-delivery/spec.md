## ADDED Requirements

### Requirement: The announcement posts on its own daily schedule

The system SHALL post the rendered announcement to the attendance channel at a configured time on each configured weekday, driven by its own timed task. The time, the weekdays, and an enabled flag SHALL be stored as data and editable by an administrator; the cron expression SHALL be derived from them and never stored, so an administrator edits a time and never a cron string. Defaults SHALL be 19:00 Asia/Dhaka, every weekday, enabled.

#### Scenario: Announce time reached on an active day

- **WHEN** the Dhaka wall clock reaches the configured announce time on a weekday included in the announcement schedule and the schedule is enabled
- **THEN** the rendered announcement is posted to the attendance channel

#### Scenario: Announce time reached on an excluded day

- **WHEN** the announce time is reached on a weekday not included in the announcement schedule
- **THEN** nothing is posted

#### Scenario: Schedule disabled

- **WHEN** the announcement schedule's enabled flag is false
- **THEN** no timed post occurs, while the stored time and weekdays are retained

#### Scenario: Schedule edited

- **WHEN** an administrator changes the announce time or weekdays
- **THEN** the timed task is rebuilt to the new values without a process restart
- **AND** the reported next run reflects the new values

### Requirement: The announcement schedule is independent of the daily-update window

The system SHALL keep the announcement's time, weekdays, and enabled flag separate from the `#daily-update` open/lock schedule. Changing or disabling either SHALL have no effect on the other, even when both are configured for the same time of day.

#### Scenario: Both configured for 19:00

- **WHEN** the daily-update open time and the announce time are both 19:00
- **THEN** the channel opens and the announcement posts as two separate actions, and a failure of one does not prevent the other

#### Scenario: Daily-update schedule disabled

- **WHEN** the `#daily-update` schedule is disabled
- **THEN** the announcement still posts on its own schedule

#### Scenario: Announcement schedule disabled

- **WHEN** the announcement schedule is disabled
- **THEN** `#daily-update` still opens and locks on its own schedule

#### Scenario: Close time is still shared as a value

- **WHEN** the announcement renders `{{close_time}}`
- **THEN** it reads the stored daily-update close time, so the two never state different closing times

### Requirement: The announcement is posted to the configured attendance channel

The system SHALL resolve the target channel by `ATTENDANCE_CHANNEL_ID` and SHALL confirm it is a text channel in the configured guild before posting. No logic SHALL key off a channel's name. Posting SHALL be confined to a single module, so there is exactly one code path that writes to the attendance channel.

#### Scenario: Channel resolves

- **WHEN** the configured ID names a text channel in the configured guild
- **THEN** the message is posted there

#### Scenario: ID points at another guild's channel

- **WHEN** the configured ID resolves to a channel in a different guild
- **THEN** nothing is posted and the mismatch is recorded as the send outcome

#### Scenario: Discord is not connected

- **WHEN** the announcement is due while the bot is not connected to the gateway
- **THEN** no post is attempted and the outcome is recorded as a connection failure

### Requirement: The announcement is posted at most once per Dhaka day

The system SHALL record one send per key and Dhaka civil date, and SHALL claim that record before sending so that a second attempt for the same day does not post a second message. The claim SHALL be enforced by a database uniqueness constraint rather than by reading before writing, because a restart, a manual send racing the timed one, and a second replica can all attempt the send at the same moment.

#### Scenario: Process restarts at the announce time

- **WHEN** the process restarts while a post for today has already been recorded
- **THEN** no second announcement is posted

#### Scenario: Two attempts race

- **WHEN** the timed task and a manual send begin at the same instant
- **THEN** exactly one message is posted and the other attempt reports that today's announcement was already sent

#### Scenario: The next day

- **WHEN** the announce time is reached on the following Dhaka date
- **THEN** a new claim is taken and the announcement is posted again

#### Scenario: A failed send does not consume the day

- **WHEN** the post fails because the bot lacks permission
- **THEN** the failure is recorded and a later attempt on the same day is allowed to post

### Requirement: Administrators can post immediately and can suppress a day

The system SHALL let an administrator post the announcement immediately, independently of the schedule. A manual send SHALL respect the once-per-day claim by default and SHALL refuse a duplicate with a clear conflict rather than posting twice; an explicit override SHALL be required to post a second time in one day. A manual send SHALL work regardless of whether this process runs the timed tasks.

#### Scenario: Manual send after a missed run

- **WHEN** an administrator triggers a send on a day nothing was posted
- **THEN** the announcement is posted and the day is recorded

#### Scenario: Manual send when today is already posted

- **WHEN** an administrator triggers a send and today's announcement was already posted
- **THEN** the request is refused as a conflict naming the time of the earlier post
- **AND** nothing is posted

#### Scenario: Deliberate second post

- **WHEN** an administrator triggers a send with the explicit override after today's announcement was already posted
- **THEN** a second message is posted and recorded

#### Scenario: Manual send on a process that does not run the timed tasks

- **WHEN** the timed tasks are switched off for this process
- **THEN** the manual send still posts

### Requirement: Only one process runs the timed announcement

The system SHALL gate the timed announcement task on the same per-process switch that gates the channel open/lock jobs, so multiple replicas do not each fire it. The manual send and the status read SHALL remain available on every process.

#### Scenario: Timed tasks switched off for a process

- **WHEN** the per-process scheduler switch is false
- **THEN** that process registers no announcement task and logs that it will not run it

#### Scenario: Switch unset

- **WHEN** the switch is not set
- **THEN** the process runs the timed announcement, matching the existing default

### Requirement: Every send outcome is recorded and reported

The system SHALL record each attempt's outcome — posted, refused as already sent, or failed with the reason — including the identifier of the posted message and any mention targets that could not be resolved, and SHALL report the most recent outcome and the next scheduled run to administrators. A missing `Send Messages` permission on the attendance channel SHALL be reported distinctly, since its only other symptom is a channel that silently goes quiet.

#### Scenario: Successful post

- **WHEN** the announcement is posted
- **THEN** the outcome records the Dhaka date, the time, the posted message identifier, and the mention targets used

#### Scenario: Missing Send Messages permission

- **WHEN** Discord refuses the post because the bot lacks permission on the attendance channel
- **THEN** the status response reports a permission failure naming the channel and the required permission

#### Scenario: Reading status

- **WHEN** an administrator reads the announcement status
- **THEN** the response includes the schedule, whether this process runs the timed task, the next scheduled run, whether today has been posted, and the last outcome

### Requirement: Announcement failures stay contained

The system SHALL contain every failure in the timed task and the posting module: no failure SHALL propagate out of the task, take down the HTTP API, the Discord gateway connection, daily-update ingestion, or the channel open/lock jobs, and the following day's task SHALL remain registered. Failures reaching an administrator's request SHALL be turned into an error response by the service layer, which is the only layer in this feature that raises one.

#### Scenario: Discord rejects the post

- **WHEN** the post fails during a timed run
- **THEN** the failure is logged and recorded, the process keeps serving requests, and the task remains registered for the next day

#### Scenario: The template cannot be read

- **WHEN** the database is unreachable at the announce time
- **THEN** the failure is recorded as the last outcome and nothing else in the process is affected

### Requirement: The announcement is not mistaken for a daily update

The system SHALL post the announcement as the bot, so the existing bot-author filter in daily-update ingestion excludes it. No `daily_updates` row SHALL be created for an announcement.

#### Scenario: Announcement posted

- **WHEN** the announcement is posted
- **THEN** no daily update record is created for it and no member is credited with an update
