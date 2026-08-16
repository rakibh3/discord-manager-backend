# schedule-configuration Specification

## Purpose

Defines the stored schedule that drives channel automation: the open and close times, the weekdays they apply to, and an enabled flag, all editable by an administrator without a code change, a redeploy, or a restart. The times belong to the people running the program — an exam week or a holiday changes them — so they are data rather than constants.

The shape is deliberately narrow. Times are `HH:mm` wall-clock values in `Asia/Dhaka`, never cron expressions, because a mistyped cron produces a job that fires happily at the wrong hour with no error anywhere. The timezone is fixed rather than configurable, because every date in the attendance domain is a Dhaka civil date and a schedule in another zone would open the channel out of step with the day its records are filed under. And a window may not cross midnight, because a message posted after midnight belongs to the next day's records, which would make the dashboard look broken rather than misconfigured.

## Requirements

### Requirement: The schedule is stored, not compiled in

The system SHALL persist the daily-update channel's schedule as data: an open time, a close time, the weekdays it applies to, and an enabled flag. Changing when the channel opens or closes SHALL NOT require a code change, a redeploy, or a restart.

#### Scenario: Schedule read before it has ever been saved

- **WHEN** the schedule is read for the first time and no row exists
- **THEN** a row is created with an open time of `18:00`, a close time of `23:59`, all seven weekdays active, and the schedule enabled
- **AND** those values are returned

#### Scenario: Exactly one schedule per channel

- **WHEN** the schedule is read or written concurrently
- **THEN** at most one stored schedule exists for the daily-update channel

#### Scenario: Stored values survive a restart

- **WHEN** the process restarts after a schedule change
- **THEN** the scheduler registers its jobs from the stored values, not from defaults

### Requirement: Times are expressed as Dhaka wall-clock times

The system SHALL store the open and close times as `HH:mm` in 24-hour form, interpreted in `Asia/Dhaka`. The timezone SHALL be fixed to `Asia/Dhaka` and SHALL NOT be configurable, because every date in the attendance domain is a Dhaka civil date and a schedule in another zone would open the channel out of step with the day its records are filed under.

#### Scenario: Valid time accepted

- **WHEN** an open time of `18:00` and a close time of `23:59` are submitted
- **THEN** they are accepted and stored unchanged

#### Scenario: Malformed time rejected

- **WHEN** a time is submitted as `6:00 PM`, `25:00`, `18:60`, `1800`, or an empty string
- **THEN** the request is rejected with a validation error naming the field

#### Scenario: Timezone reported but not accepted

- **WHEN** the schedule is read
- **THEN** the response states the timezone as `Asia/Dhaka`

#### Scenario: Timezone supplied in an update

- **WHEN** a request attempts to set a timezone
- **THEN** the stored timezone remains `Asia/Dhaka`

#### Scenario: Server running in another timezone

- **WHEN** the process runs with a `TZ` other than `Asia/Dhaka`
- **THEN** the jobs still fire at the configured Dhaka wall-clock times

### Requirement: The window may not cross Dhaka midnight

The system SHALL require the close time to be strictly later than the open time, so the submission window lies inside a single Dhaka calendar day. A window spanning midnight SHALL be refused.

#### Scenario: Close after open

- **WHEN** the open time is `18:00` and the close time is `23:59`
- **THEN** the schedule is accepted

#### Scenario: Close before open

- **WHEN** the open time is `22:00` and the close time is `02:00`
- **THEN** the request is rejected with an error explaining that the window may not cross midnight

#### Scenario: Close equal to open

- **WHEN** the open and close times are identical
- **THEN** the request is rejected

#### Scenario: Cross-midnight submitted as a partial update

- **WHEN** only the close time is changed, to a value earlier than the stored open time
- **THEN** the request is rejected, because validation applies to the resulting schedule and not only to the submitted fields

### Requirement: Active weekdays are selectable

The system SHALL store the weekdays on which the schedule runs, as integers where `0` is Sunday through `6` is Saturday, defaulting to all seven. At least one weekday SHALL be selected.

#### Scenario: Subset of days accepted

- **WHEN** the weekdays are set to Sunday through Thursday
- **THEN** the schedule is accepted and the jobs only run on those days

#### Scenario: Empty selection rejected

- **WHEN** an empty list of weekdays is submitted
- **THEN** the request is rejected, because a schedule that can never fire is a configuration mistake and not a way to pause the schedule

#### Scenario: Out-of-range or duplicate day rejected

- **WHEN** the submitted weekdays include a value below `0`, above `6`, a non-integer, or the same day twice
- **THEN** the request is rejected with a validation error

### Requirement: The schedule can be paused without losing its values

The system SHALL provide an enabled flag that stops the timed jobs while leaving the stored times and weekdays intact.

#### Scenario: Disabling the schedule

- **WHEN** an administrator disables the schedule
- **THEN** the open and lock jobs stop running
- **AND** the stored times and weekdays are unchanged

#### Scenario: Re-enabling the schedule

- **WHEN** an administrator re-enables the schedule
- **THEN** the jobs resume from the stored values with no further input

#### Scenario: Channel state when disabled

- **WHEN** the schedule is disabled while the channel is open
- **THEN** the channel remains open, because disabling stops the scheduler rather than closing the channel

### Requirement: A saved schedule takes effect immediately

The system SHALL apply a saved schedule without a restart: existing timed jobs are discarded and re-registered from the new values, and the channel's state is reconciled against the new window.

#### Scenario: Times changed

- **WHEN** an administrator changes the open time
- **THEN** the previously registered open job no longer fires at the old time
- **AND** a job is registered for the new time

#### Scenario: Save moves the current moment inside the window

- **WHEN** a saved change means the current Dhaka time now falls inside the window and the channel is locked
- **THEN** the channel is opened as part of the reconciliation

#### Scenario: Save moves the current moment outside the window

- **WHEN** a saved change means the current Dhaka time now falls outside the window and the channel is open
- **THEN** the channel is locked as part of the reconciliation

#### Scenario: Re-registration fails

- **WHEN** the saved values are stored but re-registering the jobs fails
- **THEN** the stored change is kept, the failure is logged, and it is reported through the schedule status rather than surfacing as a failed save

### Requirement: Only administrators may read or change the schedule

The system SHALL require an authenticated administrator for every schedule read and write. The schedule endpoints SHALL NOT be publicly reachable.

#### Scenario: Administrator request

- **WHEN** an authenticated administrator reads or updates the schedule
- **THEN** the request is served

#### Scenario: Missing or invalid credentials

- **WHEN** a request carries no token or an invalid one
- **THEN** it is rejected as unauthorized and no change is made

#### Scenario: Inactive administrator account

- **WHEN** the requesting account is not in an active state
- **THEN** the request is rejected

### Requirement: Schedule changes record who made them

The system SHALL record the administrator who last updated the schedule and when, and SHALL report both when the schedule is read.

#### Scenario: Update attribution

- **WHEN** an administrator saves a schedule change
- **THEN** the stored schedule records that administrator's identity and the time of the change

#### Scenario: Reading attribution

- **WHEN** the schedule is read
- **THEN** the response includes who last changed it and when

#### Scenario: Never changed

- **WHEN** the schedule is read while still holding its created defaults
- **THEN** the response reports that it has not been changed by an administrator

### Requirement: The schedule read reports what will happen next

The system SHALL report, alongside the stored values, the next open and lock instants implied by the schedule, so an administrator can confirm a change did what they intended without waiting for it to fire.

#### Scenario: Enabled schedule

- **WHEN** the schedule is read while enabled and running
- **THEN** the response includes the next open time and the next lock time as instants

#### Scenario: Disabled schedule

- **WHEN** the schedule is read while disabled
- **THEN** the response reports no next run times

#### Scenario: Days excluded

- **WHEN** the schedule runs only on Sunday through Thursday and is read on a Friday
- **THEN** the reported next open time is on the following Sunday
